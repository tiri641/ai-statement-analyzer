export class UniqueConstraintError extends Error {
  public constructor() {
    super("一意制約に違反しました");
    this.name = "UniqueConstraintError";
  }
}
