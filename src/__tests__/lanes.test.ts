import { describe, it, expect } from "vitest";
import { inferLanesByClass, parseLaneTag } from "../traffic/lanes";

describe("lane helpers", () => {
  it("parses lane counts from tags", () => {
    expect(parseLaneTag("3")).toBe(3);
    expect(parseLaneTag("2;1")).toBe(2);
    expect(parseLaneTag("lanes=4")).toBe(4);
    expect(parseLaneTag("0")).toBeUndefined();
    expect(parseLaneTag("none")).toBeUndefined();
  });

  it("infers lanes from road class", () => {
    expect(inferLanesByClass("motorway")).toBe(4);
    expect(inferLanesByClass("residential")).toBe(2);
    expect(inferLanesByClass("unknown")).toBe(2);
  });
});
