import { describe, it, expect } from "vitest";
import { inferDedicatedTurnLane, inferLanesByClass, parseLaneTag, parseTurnLaneTag } from "../traffic/lanes";

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

  it("infers dedicated turn lanes from tags and lane drops", () => {
    const parsed = parseTurnLaneTag("left|through|right");
    expect(parsed?.left).toBe(1);
    expect(parsed?.right).toBe(1);

    expect(
      inferDedicatedTurnLane({
        movement: "left",
        incomingLanes: 2,
        straightLanes: 1,
        turnLanesTag: undefined
      })
    ).toBe(true);

    expect(
      inferDedicatedTurnLane({
        movement: "right",
        incomingLanes: 1,
        straightLanes: 1,
        turnLanesTag: "through;right|through"
      })
    ).toBe(false);

    expect(
      inferDedicatedTurnLane({
        movement: "right",
        incomingLanes: 1,
        straightLanes: 1,
        turnLanesTag: "right|through"
      })
    ).toBe(true);
  });
});
