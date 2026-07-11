import { defineMcp } from "@lovable.dev/mcp-js";
import extractInvoiceTool from "./tools/extract-invoice";

export default defineMcp({
  name: "gstdesk-mcp",
  title: "GSTDesk MCP",
  version: "0.1.0",
  instructions:
    "Tools for GSTDesk. Use `extract_gst_invoice` to turn raw Indian GST invoice text into structured fields (invoice no, date, customer, GSTIN, place of supply, per-rate rows, and per-line HSN/SAC items).",
  tools: [extractInvoiceTool],
});
