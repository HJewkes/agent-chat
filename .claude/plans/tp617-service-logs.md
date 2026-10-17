# TP617 service logs bounded checkpoint
UTC: 2026-10-17T20:33:06.496627+00:00
Capture original product-boundary argv, file reads, output/status/help against exact e79 before production edits. All fs/logPath/service-controller/process/broker boundaries fake; no service lifecycle, native/account/config or live logs.
Use existing schema preprocess(parseInt policy, custom typeof number).default(50), preserving NaN/negative/zero semantics. Product addVerb opt-in schemaDefaults:true only on service.logs uses existing optionDefault; no new package API or global adoption. Remove old logs engine, preserve tailLines compatibility. Original CLI/MCP/port/send/answer/labels help/assertions unchanged.
Validation-only e063 tar install no-save/nolock, unchanged manifests. Focused tests/types/build/format/audit and substantive mutants only, no global-marker/full job. Freeze separate commit for independent review then restore frozen npmci; TP617 remains OPEN.

Results: original19-case golden captured before conversion, final typed fixture independently rerun against exact e79 source overlay without updates and source restored. Golden byte unchanged. Final131tests/10files, product/test/dashboard types, build, formatting and spawn audit exit0. Four default/parse/tail/read-refusal mutants killed then restored. Numeric default uses typed Commander Option.default(unknown); only logs opts in. Manifest/lock and reviewed e063 tar JS/DTS binding exact. Await independent review; candidate retained then frozen npmci restoration required.
UTC: 2026-10-17T20:36:31.382734+00:00
