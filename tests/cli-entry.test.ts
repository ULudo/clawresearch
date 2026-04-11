import test from "node:test";
import assert from "node:assert/strict";
import { main } from "../src/cli.js";

function capture(): { output: string; writer: { write: (chunk: string) => void } } {
  let output = "";
  return {
    get output() {
      return output;
    },
    writer: {
      write(chunk: string) {
        output += chunk;
      }
    }
  };
}

test("default entry prints reset hint", () => {
  const sink = capture();
  const code = main([], sink.writer);

  assert.equal(code, 0);
  assert.match(sink.output, /minimal TypeScript scaffold/);
  assert.match(sink.output, /clawresearch --docs/);
});

test("docs flag prints concept files", () => {
  const sink = capture();
  const code = main(["--docs"], sink.writer);

  assert.equal(code, 0);
  assert.match(sink.output, /docs\/reset-development-concept\.md/);
  assert.match(sink.output, /docs\/autonomous-research-agent-literature-synthesis\.md/);
});
