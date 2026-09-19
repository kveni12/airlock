import { greet } from "./src/app.js";

if (greet("agent") !== "hello agent") {
  throw new Error("greet() returned the wrong value");
}

console.log("demo tests passed");
