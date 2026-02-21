export class ToolYamlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolYamlError';
  }
}
