import {
  InvalidAnalyzeJobMessageError,
  type AnalyzeJobQueue,
  type ReceivedAnalyzeJob,
} from "../queue/analyze-job.js";

const INITIAL_RECEIVE_BACKOFF_MS = 1_000;
const MAX_RECEIVE_BACKOFF_MS = 30_000;
const RECEIVE_BACKOFF_MULTIPLIER = 2;

export interface WorkerLogger {
  info(fields: Record<string, unknown>): void;
  error(fields: Record<string, unknown>): void;
}

export type AnalyzeJobHandler = (job: ReceivedAnalyzeJob) => Promise<void>;

export interface AnalyzeWorkerOptions {
  queue: AnalyzeJobQueue;
  handleJob: AnalyzeJobHandler;
  sleep?: (milliseconds: number) => Promise<void>;
  logger?: WorkerLogger;
}

export interface WorkerSignalEmitter {
  once(signal: "SIGTERM" | "SIGINT", listener: () => void): unknown;
}

const defaultLogger: WorkerLogger = {
  info: (fields) => console.log(JSON.stringify(fields)),
  error: (fields) => console.error(JSON.stringify(fields)),
};

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
  private readonly shutdownAbortController = new AbortController();
  private readonly shutdownPromise: Promise<void>;
  private resolveShutdown!: () => void;
  private receiveAbortController: AbortController | undefined;
  private shutdownRequested = false;

  public constructor(options: AnalyzeWorkerOptions) {
    this.queue = options.queue;
    this.handleJob = options.handleJob;
    this.sleep =
      options.sleep ?? ((milliseconds) => this.sleepUntilShutdown(milliseconds));
    this.logger = options.logger ?? defaultLogger;
    this.shutdownPromise = new Promise((resolve) => {
      this.resolveShutdown = resolve;
    });
  }

  public requestShutdown(): void {
    if (this.shutdownRequested) {
      return;
    }

    this.shutdownRequested = true;
    this.receiveAbortController?.abort();
    this.shutdownAbortController.abort();
    this.resolveShutdown();
    this.logger.info({ event: "worker_shutdown_requested" });
  }

  public async run(): Promise<void> {
    let receiveBackoffMs = INITIAL_RECEIVE_BACKOFF_MS;

    this.logger.info({ event: "worker_started" });

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

        this.logger.error({ event, errorCode });

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
        await this.processJob(job);
      }
    }

    this.logger.info({ event: "worker_stopped" });
  }

  private async waitForRetry(milliseconds: number): Promise<void> {
    await Promise.race([this.sleep(milliseconds), this.shutdownPromise]);
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
    this.logger.info({
      event: "worker_job_started",
      messageId: job.messageId,
      statementId: job.statementId,
      receiveCount: job.receiveCount,
    });

    try {
      await this.handleJob(job);
    } catch (error) {
      this.logger.error({
        event: "worker_job_failed",
        messageId: job.messageId,
        statementId: job.statementId,
        receiveCount: job.receiveCount,
        errorCode: getErrorCode(error),
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    try {
      await this.queue.deleteMessage(job.receiptHandle);
    } catch (error) {
      this.logger.error({
        event: "worker_delete_failed",
        messageId: job.messageId,
        statementId: job.statementId,
        receiveCount: job.receiveCount,
        errorCode: getErrorCode(error),
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    this.logger.info({
      event: "worker_job_completed",
      messageId: job.messageId,
      statementId: job.statementId,
      receiveCount: job.receiveCount,
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
