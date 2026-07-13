// calc — evaluate an arithmetic expression with the Boa runner (sandboxed JS,
// no host APIs: no require, no fs, no process). Pure ECMAScript.
//
// The expression comes from the boa runner via globalThis.expr; absent ⇒ a
// deterministic self-test ("6 * 7" → 42). Only digits and + - * / ( ) . spaces
// are accepted, so the Function() evaluation can't reach anything else.
"use strict";
var expr = (typeof globalThis !== "undefined" && globalThis.expr) || "6 * 7";
if (!/^[-+*/(). 0-9]+$/.test(expr)) {
  throw new Error("calc: arithmetic expressions only");
}
var result = Function('"use strict"; return (' + expr + ");")();
console.log(String(result));
