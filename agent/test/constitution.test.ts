import { describe, expect, it } from "vitest";
import { layerOfPath, strictest } from "../src/constitution.js";

describe("Article 2 layer of a path", () => {
  it("classifies the named files", () => {
    expect(layerOfPath("CONSTITUTION.md")).toBe("constitution");
    expect(layerOfPath("TERMS.md")).toBe("constitution");
    expect(layerOfPath("LICENSE-CONTENT")).toBe("constitution");
    expect(layerOfPath(".github/README.md")).toBe("constitution");
    expect(layerOfPath(".github/workflows/x.yml")).toBe("constitution");
    expect(layerOfPath("NOTICES.md")).toBe("owner");
    expect(layerOfPath("PRIVACY.md")).toBe("owner");
    expect(layerOfPath("ledger/events.jsonl")).toBe("ledger");
    expect(layerOfPath("world/replicator-map/nodes.json")).toBe("world");
  });
  it("sends every other path to the Laws, including unknown root files", () => {
    expect(layerOfPath("LAWS.md")).toBe("laws");
    expect(layerOfPath("laws.schema.json")).toBe("laws");
    expect(layerOfPath("package.json")).toBe("laws");
    expect(layerOfPath("_config.yml")).toBe("laws");
    expect(layerOfPath("agent/src/x.ts")).toBe("laws");
    expect(layerOfPath("site/index.html")).toBe("laws");
    expect(layerOfPath("worlds/x.md")).toBe("laws");
  });
  it("strictest wins", () => {
    expect(strictest(["world", "laws"])).toBe("laws");
    expect(strictest(["world", "constitution", "laws"])).toBe("constitution");
    expect(strictest(["world"])).toBe("world");
  });
});
