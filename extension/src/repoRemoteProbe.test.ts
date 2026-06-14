import { describe, expect, it } from "vitest";
import {
  formatRemoteGitEvidence,
  remoteGitSignalsFromProbe,
} from "./repoRemoteProbe";

describe("repoRemoteProbe", () => {
  it("formats remote evidence when origin was probed", () => {
    const text = formatRemoteGitEvidence(
      remoteGitSignalsFromProbe({
        originUrl: "https://github.com/acme/app.git",
        reachable: true,
        remoteBranchCount: 12,
        remoteAuthors30d: 3,
        upstreamAhead: 1,
        upstreamBehind: 2,
        source: "ls-remote",
        probedAt: new Date().toISOString(),
      })
    );
    expect(text).toContain("12 remote branches");
    expect(text).toContain("ls-remote");
    expect(text).toContain("ahead 1 / behind 2");
  });

  it("reports offline when origin is unreachable", () => {
    const text = formatRemoteGitEvidence(
      remoteGitSignalsFromProbe({
        originUrl: "git@github.com:acme/app.git",
        reachable: false,
        remoteBranchCount: 0,
        remoteAuthors30d: 0,
        upstreamAhead: 0,
        upstreamBehind: 0,
        source: "none",
        probedAt: new Date().toISOString(),
        error: "origin unreachable",
      })
    );
    expect(text).toContain("not probed");
  });
});
