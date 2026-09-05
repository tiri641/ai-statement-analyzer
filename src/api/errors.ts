export class StatementConflictError extends Error {
  public constructor() {
    super("statementの作成が競合しました");
    this.name = "StatementConflictError";
  }
}
