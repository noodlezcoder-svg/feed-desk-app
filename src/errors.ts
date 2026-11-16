/** An error caused by the user or missing setup. Shown as-is, with a 4xx status. */
export class UserError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
