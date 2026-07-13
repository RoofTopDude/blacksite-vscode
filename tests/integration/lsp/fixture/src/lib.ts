export interface Greeter {
  greet(name: string): string;
}

export class EnglishGreeter implements Greeter {
  greet(name: string): string {
    return `Hello, ${name}`;
  }
}

export const unusedValue = 42;
