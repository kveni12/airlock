import assert from "node:assert/strict";
import { greeting } from "../src/greeting.js";
assert.equal(greeting("Periscope"), "Bonjour / Hola, Periscope! You are super cool!");
console.log("Greeting test passed");
