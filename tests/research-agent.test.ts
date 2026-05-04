import test from "node:test";
import assert from "node:assert/strict";
import { workspaceResearchActions } from "../src/runtime/research-agent.js";

test("architecture contract: production action surface excludes legacy orchestration aliases", () => {
  const actions = workspaceResearchActions();
  const legacyActions = [
    "extract_papers",
    "build_evidence_matrix",
    "ask_critic",
    "screen_sources",
    "search_sources",
    "revise_search_strategy",
    "work_store.query",
    "work_store.read",
    "work_store.create",
    "work_store.patch",
    "manuscript.read_section",
    "manuscript.patch_section",
    "manuscript.add_paragraph",
    "manuscript.check_section_claims",
    "manuscript.status"
  ];

  for (const action of legacyActions) {
    assert.equal(actions.includes(action as never), false, `${action} must not be model-facing production surface`);
  }
});

test("architecture contract: milestone labels do not narrow the production action surface", () => {
  const actions = workspaceResearchActions();
  const expectedToolFamilies = [
    "workspace.search",
    "workspace.read",
    "source.search",
    "source.merge",
    "source.resolve_access",
    "source.select_evidence",
    "extraction.create",
    "evidence.create_cell",
    "evidence.matrix_view",
    "claim.create",
    "claim.link_support",
    "section.create",
    "section.patch",
    "critic.review",
    "check.run",
    "release.verify",
    "manuscript.release"
  ];

  for (const action of expectedToolFamilies) {
    assert.equal(actions.includes(action as never), true, `${action} should remain available independent of milestone label`);
  }
});
