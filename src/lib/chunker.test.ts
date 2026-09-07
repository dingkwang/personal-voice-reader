import { describe, expect, it } from "vitest";
import { chunkText, inferTitle } from "./chunker";

describe("chunkText", () => {
  it("returns no segments for empty input", () => {
    expect(chunkText("  \n\n ")).toEqual([]);
  });

  it("keeps short prose in one segment", () => {
    expect(chunkText("第一句。第二句！")).toEqual(["第一句。第二句！"]);
  });

  it("splits long Chinese prose on sentence boundaries", () => {
    const text = Array.from({ length: 100 }, (_, index) => `这是第${index}句话。`).join("");
    const chunks = chunkText(text, { targetLength: 80, maxLength: 100 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 100)).toBe(true);
    expect(chunks.join("")).toBe(text);
  });

  it("hard-splits text without punctuation", () => {
    const text = "声".repeat(260);
    const chunks = chunkText(text, { targetLength: 80, maxLength: 100 });

    expect(chunks.every((chunk) => chunk.length <= 100)).toBe(true);
    expect(chunks.join("")).toBe(text);
  });

  it("normalizes BOM, CRLF, and repeated whitespace", () => {
    expect(chunkText("\uFEFF你好。\r\n\r\n\r\n   世界。"))
      .toEqual(["你好。", "世界。"]) ;
  });
});

describe("inferTitle", () => {
  it("uses the first non-empty line", () => {
    expect(inferTitle("\n\n一篇文章\n正文")).toBe("一篇文章");
  });

  it("truncates a long first line", () => {
    expect(inferTitle("好".repeat(50))).toBe(`${"好".repeat(34)}…`);
  });
});
