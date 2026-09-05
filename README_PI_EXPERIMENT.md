# Pi Agent CADGenBench Workflow Experiment

This branch runs a Pi-only CADGenBench generation experiment. It is not a rerun
of the official strongest harness and does not inject that harness's full CAD
prompt or domain-specific heuristics into either arm.

## Research Question

Under otherwise identical runtime, model, tool, fixture, and output conditions,
does appending a high-level step-by-step construction workflow improve Pi
Agent's CAD generation compared with the default Pi Agent baseline?

## Arms

| Arm | Variant name | Prompt |
| --- | --- | --- |
| Pi Agent baseline | `pi-agent` | `prompt_pi_agent_base.txt` only |
| Pi Agent + step-by-step | `step-by-step` | The identical base prompt followed by `prompt_step_by_step_workflow.txt` |

The baseline is not explicitly instructed to be one-shot. Pi may naturally
construct the complete model in one action or choose its own tool sequence;
actual behavior can be measured later from `stream.jsonl`. The treatment arm
adds the requested high-level sequence:

```text
read drawing and organize dimensions
  -> establish main section/base
  -> add holes, slots, bosses, and other features
  -> validate
  -> save first valid checkpoint
  -> render/measure/cross-section inspect
  -> correct largest discrepancy
  -> validate and checkpoint again
  -> final export
```

The workflow does not prescribe the number of `execute()` calls. It is a
semantic workflow scaffold, not a tool-call-count constraint.

## Prompt Control

Both arms receive the exact same base prompt:

- `harness/prompt_pi_agent_base.txt`

The `step-by-step` arm receives that prompt unchanged, followed by:

- `harness/prompt_step_by_step_workflow.txt`

The added workflow is limited to the high-level sequence above. Neither arm
receives the official harness's dimension-table procedure, arithmetic-chain
rules, side-profile-first heuristic, wall-thickness heuristic, dominant-form
gate, MCP skill-resource instructions, or other full-prompt CAD tactics.

The test suite checks that:

- the baseline prompt contains no `## Step-by-step workflow` section;
- the treatment prompt is the baseline followed by that workflow;
- both prompts use the exact scored output path;
- neither prompt contains the excluded official harness heuristics;
- neither prompt imposes an exact initial `execute()` count.

## Controlled Variables

Both arms use:

- The same CADGenBench generation fixture and `input.png`.
- The same Pi CLI process flags and extension loading order.
- The same model: `alibaba-qwen-dashscope-native/qwen3.8-flash:high`.
- Temperature `0` through the Pi model configuration.
- The same build123d MCP server spec: `build123d-mcp==0.3.81`.
- The same execute timeout, defaulting to 300 seconds.
- The same non-drawing build123d MCP tool surface.
- The same working-directory preparation and stale-artifact cleanup.
- The same STEP output contract and exact `output.step` path substitution.

The intended experimental variable is the addition of the high-level workflow.

## Implementation Map

- `harness/run_pi_experiment.mjs`
  Prepares an isolated run directory, renders the selected prompt, invokes Pi
  with isolated flags, captures the JSON stream and stderr, and records run
  metadata.

- `harness/pi_build123d_mcp.ts`
  Implements the Pi extension and JSON-RPC MCP client. It starts one
  build123d MCP process, registers the returned non-drawing tools with Pi, and
  keeps the process alive for the session so geometry state persists between
  tool calls.

- `harness/prompt_pi_agent_base.txt`
  The shared, minimal CAD benchmark task prompt used by both arms.

- `harness/prompt_step_by_step_workflow.txt`
  The high-level workflow appended only to the `step-by-step` arm.

- `harness/run_pi_experiment.test.mjs`
  Runner, invocation-isolation, and prompt-contract tests.

## Local Layout

The default paths expect this sibling-directory layout:

```text
parent/
  repo/             this repository
  pi/               https://github.com/earendil-works/pi
  build123d-mcp/    https://github.com/pzfreo/build123d-mcp
```

The default Pi CLI path is:

```text
../pi/packages/coding-agent/dist/bundle/cli.js
```

Build Pi before running the experiment:

```powershell
cd ..\pi
npm install
npm run build
```

The DashScope provider extension and credentials are configured in the user's
Pi environment. The runner defaults to:

```text
%USERPROFILE%\.pi\agent\git\github.com\Yiki21\pi-dashscope-native\src\index.ts
```

Override it with `--provider-extension` when using a different checkout.

Temperature is configured in Pi's model settings rather than passed as a
runner flag:

```json
{
  "providers": {
    "alibaba-qwen-dashscope-native": {
      "modelOverrides": {
        "qwen3.8-flash": {
          "samplingParams": {
            "temperature": 0
          }
        }
      }
    }
  }
}
```

## Tests

Run the runner and prompt-isolation tests:

```powershell
node --test harness\run_pi_experiment.test.mjs
```

The current expected result is six passing tests and zero failures.

## Run One Fixture

Run the Pi baseline:

```powershell
node harness\run_pi_experiment.mjs `
  --fixture work\fixtures\118 `
  --work work\pi-runs\118-pi-agent `
  --variant pi-agent
```

Run the step-by-step arm:

```powershell
node harness\run_pi_experiment.mjs `
  --fixture work\fixtures\118 `
  --work work\pi-runs\118-step-by-step `
  --variant step-by-step
```

Useful options:

- `--model provider/model:thinking`
- `--mcp-spec build123d-mcp==0.3.81`
- `--exec-timeout 300`
- `--pi path\to\pi\cli.js`
- `--extension path\to\pi_build123d_mcp.ts`
- `--provider-extension path\to\dashscope\extension`

## Run Artifacts

Each run directory contains:

- `prompt.txt`: the exact rendered prompt sent to Pi.
- `stream.jsonl`: Pi events, assistant messages, tool calls, and tool results.
- `pi.stderr.log`: Pi/provider diagnostics.
- `run_meta.json`: model, variant, paths, MCP spec, timeout, timestamps, exit
  code, and whether the output was produced.
- `output.step`: the generated CAD candidate.

`stream.jsonl` can be large because render results are embedded as base64
images. Do not commit benchmark fixtures, streams, rendered images, STEP files,
credentials, or API configuration to this repository.

## Current Status And Limitations

- The Pi bridge and persistent build123d MCP session are implemented.
- The Pi baseline versus appended high-level workflow prompt contract is
  implemented and tested.
- No controlled smoke run has yet been completed with this final prompt
  contract. Earlier fixture-118 runs used the superseded prompt design and are
  not formal data points.
- Formal sweeps, repeated trials, and official CADGenBench scoring/packaging
  are not yet wired for this Pi-only runner.
- The current experiment covers generation fixtures only; editing fixtures are
  unsupported.
- Both arms receive the same non-drawing MCP tools, so tool access does not
  differ. The bridge does not reproduce the official Claude driver's curated
  17-tool allowlist.
- `run_meta.json` does not yet record the effective temperature, git commit,
  dirty state, resolved MCP package version, or local patch status.
- Windows smoke testing uses a local worker fix in the sibling `build123d-mcp`
  checkout. The geometry workflow is unchanged, but provenance should disclose
  that local patch until it is upstreamed or committed here as a patch file.
