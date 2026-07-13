import { EnglishGreeter, unusedValue } from "./lib.js";

const greeter=new EnglishGreeter();
export const message=greeter.greet("Relay");
console.log(message);
