import { describe, expect, it } from "vitest";

import {
  TASKPANE_SEARCH_PANEL_SHELL_FOOTER,
  TASKPANE_SEARCH_PANEL_SHELL_HEADER,
  TASKPANE_SEARCH_PANEL_SHELL_STACKED,
} from "./taskpaneSearchPanelLayout";

describe("taskpaneSearchPanelLayout", () => {
  it("keeps stacked header and footer shells aligned", () => {
    expect(TASKPANE_SEARCH_PANEL_SHELL_HEADER).toBe(TASKPANE_SEARCH_PANEL_SHELL_STACKED);
    expect(TASKPANE_SEARCH_PANEL_SHELL_FOOTER).toBe(TASKPANE_SEARCH_PANEL_SHELL_STACKED);
    expect(TASKPANE_SEARCH_PANEL_SHELL_STACKED).toContain("py-2");
  });
});
