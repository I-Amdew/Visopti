import { describe, it, expect } from "vitest";
import { shouldIgnoreGlobalKeyEvents } from "../drawing";

describe("shouldIgnoreGlobalKeyEvents", () => {
  it("returns false when there is no active element", () => {
    expect(shouldIgnoreGlobalKeyEvents(null)).toBe(false);
  });

  it("ignores input and textarea elements", () => {
    const input = { tagName: "INPUT" } as unknown as Element;
    const textarea = { tagName: "textarea" } as unknown as Element;
    expect(shouldIgnoreGlobalKeyEvents(input)).toBe(true);
    expect(shouldIgnoreGlobalKeyEvents(textarea)).toBe(true);
  });

  it("ignores contenteditable elements", () => {
    const editable = { tagName: "DIV", isContentEditable: true } as unknown as Element;
    const attrEditable = {
      tagName: "DIV",
      getAttribute: (name: string) => (name === "contenteditable" ? "true" : null)
    } as unknown as Element;
    expect(shouldIgnoreGlobalKeyEvents(editable)).toBe(true);
    expect(shouldIgnoreGlobalKeyEvents(attrEditable)).toBe(true);
  });

  it("allows non-editable elements", () => {
    const div = {
      tagName: "DIV",
      isContentEditable: false,
      getAttribute: () => "false"
    } as unknown as Element;
    expect(shouldIgnoreGlobalKeyEvents(div)).toBe(false);
  });
});
