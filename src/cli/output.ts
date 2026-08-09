import pc from "picocolors";

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function heading(value: string): void {
  process.stdout.write(`${pc.bold(value)}\n`);
}

export function success(value: string): void {
  process.stdout.write(`${pc.green("✓")} ${value}\n`);
}

export function warning(value: string): void {
  process.stdout.write(`${pc.yellow("!")} ${value}\n`);
}

export function line(value = ""): void {
  process.stdout.write(`${value}\n`);
}
