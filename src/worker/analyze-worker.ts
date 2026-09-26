import {
  InvalidAnalyzeJobMessageError,
  type AnalyzeJobQueue,
  type ReceivedAnalyzeJob,
} from "../queue/analyze-job.js";
import {
  createStructuredLogger,
  type StructuredLogger,
} from "../observability/logger.js";
import { getAnalyzeJobErrorStage } from "./analyze-job-error.js";

const INITIAL_RECEIVE_BACKOFF_MS = 1_000;
const MAX_RECEIVE_BACKOFF_MS = 30_000;
const RECEIVE_BACKOFF_MULTIPLIER = 2;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

export type WorkerLogger = StructuredLogger;

export interface AnalyzeJobHandlerOptions {
  signal: AbortSignal;
}

export type AnalyzeJobDisposition = "ACK" | "RETRY";

export type AnalyzeJobHandler = (
  job: ReceivedAnalyzeJob,
  options?: AnalyzeJobHandlerOptions,
) => Promise<void | AnalyzeJobDisposition>;

export interface AnalyzeWorkerOptions {
  queue: AnalyzeJobQueue;
  handleJob: AnalyzeJobHandler;
  sleep?: (milliseconds: number) => Promise<void>;
  logger?: WorkerLogger;
  shutdownTimeoutMs?: number;
}

export interface WorkerSignalEmitter {
  once(signal: "SIGTERM" | "SIGINT", listener: () => void): unknown;
}

const defaultLogger: WorkerLogger = createStructuredLogger({
  service: "worker",
});

type ShutdownOperationResult<T> =
  | { status: "COMPLETED"; value: T }
  | { status: "FAILED"; error: unknown }
  | { status: "TIMED_OUT" };

function getErrorCode(error: unknown): string {
  if (error instanceof InvalidAnalyzeJobMessageError) {
    return "INVALID_MESSAGE";
  }

  if (error instanceof Error && error.name) {
    return error.name;
  }

  return "UNKNOWN_ERROR";
}

export class AnalyzeWorker {
  private readonly queue: AnalyzeJobQueue;
  private readonly handleJob: AnalyzeJobHandler;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly logger: WorkerLogger;
  private readonly shutdownTimeoutMs: number;
  private readonly shutdownAbortController = new AbortController();
  private readonly shutdownPromise: Promise<void>;
  private resolveShutdown!: () => void;
  private receiveAbortController: AbortController | undefined;
  private activeHandlerAbortController: AbortController | undefined;
  private shutdownDeadlineAt: number | undefined;
  private shutdownRequested = false;

  public constructor(options: AnalyzeWorkerOptions) {
    this.queue = options.queue;
    this.handleJob = options.handleJob;
    this.sleep =
      options.sleep ?? ((milliseconds) => this.sleepUntilShutdown(milliseconds));
    this.logger = options.logger ?? defaultLogger;
    this.shutdownTimeoutMs =
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.shutdownPromise = new Promise((resolve) => {
      this.resolveShutdown = resolve;
    });
  }

  public requestShutdown(): void {
    if (this.shutdownRequested) {
      return;
    }

    this.shutdownRequested = true;
    this.shutdownDeadlineAt = Date.now() + this.shutdownTimeoutMs;
    this.receiveAbortController?.abort();
    this.activeHandlerAbortController?.abort();
    this.shutdownAbortController.abort();
    this.resolveShutdown();
    this.logger.info({ event: "worker_shutdown_requested", status: "requested" });
  }

  public async run(): Promise<void> {
    let receiveBackoffMs = INITIAL_RECEIVE_BACKOFF_MS;

    this.logger.info({ event: "worker_started", status: "started" });

    while (!this.shutdownRequested) {
      const controller = new AbortController();
      this.receiveAbortController = controller;

      let job: ReceivedAnalyzeJob | null;

      try {
        job = await this.queue.receiveOne({ signal: controller.signal });
      } catch (error) {
        if (this.shutdownRequested) {
          break;
        }

        const errorCode = getErrorCode(error);
        const event =
          error instanceof InvalidAnalyzeJobMessageError
            ? "worker_message_invalid"
            : "worker_receive_failed";

        this.logger.error({
          event,
          errorCode,
          status: "failed",
          disposition: event === "worker_receive_failed" ? "RETRYABLE" : "PERMANENT",
        });

        if (event === "worker_receive_failed") {
          await this.waitForRetry(receiveBackoffMs);
          receiveBackoffMs = Math.min(
            receiveBackoffMs * RECEIVE_BACKOFF_MULTIPLIER,
            MAX_RECEIVE_BACKOFF_MS,
          );
        }

        continue;
      } finally {
        if (this.receiveAbortController === controller) {
          this.receiveAbortController = undefined;
        }
      }

      receiveBackoffMs = INITIAL_RECEIVE_BACKOFF_MS;

      if (job) {
        this.logger.info({
          event: "worker_message_received",
          messageId: job.messageId,
          statementId: job.statementId,
          receiveCount: job.receiveCount,
        });
        await this.processJob(job);
      }
    }

    this.logger.info({ event: "worker_stopped", status: "stopped" });
  }

  private async waitForRetry(milliseconds: number): Promise<void> {
    await Promise.race([this.sleep(milliseconds), this.shutdownPromise]);
  }

  private async runWithShutdownTimeout<T>(
    operation: Promise<T>,
  ): Promise<ShutdownOperationResult<T>> {
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = this.shutdownPromise.then(
      () =>
        new Promise<ShutdownOperationResult<T>>((resolve) => {
          if (finished) {
            return;
          }

          const remainingMs = Math.max(
            0,
            (this.shutdownDeadlineAt ?? Date.now()) - Date.now(),
          );
          timer = setTimeout(
            () => resolve({ status: "TIMED_OUT" }),
            remainingMs,
          );
        }),
    );
    const operationPromise = operation.then(
      (value) => ({ status: "COMPLETED", value }) as const,
      (error) => ({ status: "FAILED", error }) as const,
    );

    const result = await Promise.race([operationPromise, timeoutPromise]);
    finished = true;

    if (timer) {
      clearTimeout(timer);
    }

    return result;
  }

  private sleepUntilShutdown(milliseconds: number): Promise<void> {
    if (this.shutdownAbortController.signal.aborted) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        this.shutdownAbortController.signal.removeEventListener(
          "abort",
          finish,
        );
        resolve();
      };
      const timer = setTimeout(finish, milliseconds);

      this.shutdownAbortController.signal.addEventListener("abort", finish, {
        once: true,
      });
    });
  }

  private async processJob(job: ReceivedAnalyzeJob): Promise<void> {
    const startedAt = Date.now();
    const handlerAbortController = new AbortController();
    this.activeHandlerAbortController = handlerAbortController;
    this.logger.info({
      event: "worker_job_started",
      messageId: job.messageId,
      statementId: job.statementId,
      receiveCount: job.receiveCount,
      status: "started",
    });

    let handlerResult: ShutdownOperationResult<void | AnalyzeJobDisposition>;
    try {
      handlerResult = await this.runWithShutdownTimeout(
        Promise.resolve().then(() =>
          this.handleJob(job, { signal: handlerAbortController.signal }),
        ),
      );
    } finally {
      if (this.activeHandlerAbortController === handlerAbortController) {
        this.activeHandlerAbortController = undefined;
      }
    }

    if (handlerResult.status === "FAILED") {
      this.logger.error({
        event: "worker_job_failed",
        messageId: job.messageId,
        statementId: job.statementId,
        receiveCount: job.receiveCount,
        stage: getAnalyzeJobErrorStage(handlerResult.error) ?? "unknown",
        errorCode: getErrorCode(handlerResult.error),
        status: "failed",
        disposition: "RETRYABLE",
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    if (handlerResult.status === "TIMED_OUT") {
      handlerAbortController.abort();
      this.logger.error({
        event: "worker_job_shutdown_timeout",
        messageId: job.messageId,
        statementId: job.statementId,
        receiveCount: job.receiveCount,
        errorCode: "SHUTDOWN_TIMEOUT",
        status: "failed",
        disposition: "RETRYABLE",
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    if (handlerResult.value === "RETRY") {
      this.logger.info({
        event: "worker_job_retry",
        messageId: job.messageId,
        statementId: job.statementId,
        receiveCount: job.receiveCount,
        status: "retry",
        disposition: "RETRYABLE",
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    const deleteResult = await this.runWithShutdownTimeout(
      Promise.resolve().then(() =>
        this.queue.deleteMessage(job.receiptHandle),
      ),
    );

    if (deleteResult.status === "FAILED") {
      this.logger.error({
        event: "worker_delete_failed",
        messageId: job.messageId,
        statementId: job.statementId,
        receiveCount: job.receiveCount,
        stage: "message-delete",
        errorCode: getErrorCode(deleteResult.error),
        status: "failed",
        disposition: "RETRYABLE",
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    if (deleteResult.status === "TIMED_OUT") {
      this.logger.error({
        event: "worker_delete_shutdown_timeout",
        messageId: job.messageId,
        statementId: job.statementId,
        receiveCount: job.receiveCount,
        stage: "message-delete",
        errorCode: "SHUTDOWN_TIMEOUT",
        status: "failed",
        disposition: "RETRYABLE",
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    this.logger.info({
      event: "worker_job_completed",
      messageId: job.messageId,
      statementId: job.statementId,
      receiveCount: job.receiveCount,
      stage: "message-delete",
      status: "completed",
      disposition: "ACK",
      durationMs: Date.now() - startedAt,
    });
  }
}

export function registerWorkerShutdownHandlers(
  worker: Pick<AnalyzeWorker, "requestShutdown">,
  emitter: WorkerSignalEmitter = process,
): void {
  emitter.once("SIGTERM", () => worker.requestShutdown());
  emitter.once("SIGINT", () => worker.requestShutdown());
}
