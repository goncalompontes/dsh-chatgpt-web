import { expect, test } from "bun:test";
import { partitionTextCompaction, runBoundedTextCompaction } from "../src/adapters/chatgpt-web/text-compaction";

test("oversized compaction preserves every source character, including large records and Unicode", () => {
  const source = `OLDEST-DECISION\n${"record with 🧭 中文 and escaped \\\" text\n".repeat(200)}\nLATEST-REQUEST`;
  const parts = partitionTextCompaction(source, prompt => prompt.text.length < 2_000);
  expect(parts.length).toBeGreaterThan(1);
  expect(parts.map(part => part.source).join("")).toBe(source);
  expect(parts.every(part => part.prompt.text.length < 2_000)).toBe(true);
  expect(parts.every(part => !/[\uD800-\uDBFF]$/.test(part.source) && !/^[\uDC00-\uDFFF]/.test(part.source))).toBe(true);
});

test("compaction merges every fragment and image, and never inlines base64 attachments", async () => {
  const seen: string[] = [];
  const image = { ref: "source-image", imageUrl: "data:image/png;base64,PRIVATE_IMAGE_DATA" };
  const summary = await runBoundedTextCompaction({ text: "OLDEST " + "evidence ".repeat(1000) + " NEWEST", images: [image] },
    prompt => prompt.text.length < 2_000, async prompt => {
      seen.push(prompt.text);
      expect(prompt.text).not.toContain("PRIVATE_IMAGE_DATA");
      if (prompt.images.length) expect(prompt.images).toEqual([image]);
      return prompt.text.includes("PARTIAL_CHECKPOINTS_JSON") ? "MERGED-CHECKPOINT" : `part-${seen.length}`;
    });
  expect(summary).toBe("MERGED-CHECKPOINT");
  expect(seen[0]).toContain("OLDEST");
  expect(seen.some(text => text.includes("NEWEST"))).toBe(true);
  expect(seen.some(text => text.includes("source-image"))).toBe(true);
  for (let i = 1; i < seen.length; i++) expect(seen.at(-1)).toContain(`part-${i}`);
});

test("compaction aborts without running later fragments or returning a partial checkpoint", async () => {
  const abort = new AbortController();
  let calls = 0;
  await expect(runBoundedTextCompaction({ text: "source ".repeat(1000), images: [] }, prompt => prompt.text.length < 2_000,
    async () => { calls += 1; abort.abort(new Error("cancel checkpoint")); return "partial"; }, abort.signal))
    .rejects.toThrow("cancel checkpoint");
  expect(calls).toBe(1);
});

test("empty or nonconverging compaction fails explicitly without committing partial history", async () => {
  await expect(runBoundedTextCompaction({ text: "small", images: [] }, () => true, async () => " ")).rejects.toThrow("empty");
  await expect(runBoundedTextCompaction({ text: "source ".repeat(1000), images: [] }, prompt => prompt.text.length < 2_000,
    async () => "summary ".repeat(200))).rejects.toThrow(/four levels|64-request/);
});
