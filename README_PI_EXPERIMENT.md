# Pi-only CADGenBench Step A/B Experiment

This branch contains a controlled Pi Agent experiment on CADGenBench generation
tasks. It is not a direct rerun of the official strongest submission harness.
The experiment deliberately replaces the Claude/Codex agent driver with Pi while
retaining the CAD-specific task core.

## Research question

Under otherwise identical conditions, does the official step-by-step CAD
construction workflow improve Pi Agent generation compared with an integrated
one-shot construction workflow?

## Arms

| Arm | Variant name | Construction policy |
| --- | --- | --- |
| Pi Agent | `one-shot` | Neutral one-shot baseline: analyze the complete drawing, autonomously decide the construction strategy, and make the initial geometry-changing `execute()` represent the complete attempted model without a prescribed stage-by-stage workflow. |
| Pi Agent + step-by-step | `step-by-step` | Adds the official generation workflow: dimension table first, side/Z profile before plan features, checkpointing, dominant-form correction, fidelity iteration, and a final accuracy pass. |

Both arms can use validation, rendering, measurement, feature recognizers, and
corrective execution after the initial construction. The difference is whether
the step-by-step workflow scaffold is supplied in addition to the shared CAD
task instructions.

## Controlled variables

Both arms use:

- The same CADGenBench generation fixture and `input.png`.
- The same Pi CLI process flags and extension loading order.
- The same model: `alibaba-qwen-dashscope-native/qwen3.8-flash:high`.
- Temperature `0` through the Pi model configuration.
- The same build123d MCP server spec: `build123d-mcp==0.3.81`.
- The same execute timeout, defaulting to 300 seconds.
- The same non-drawing build123d MCP tool set.
- The same working-directory preparation and stale-artifact cleanup.
- The same STEP output contract and exact `output.step` path substitution.
- The same prompt outside `Working approach`.

The intended experimental variable is the `Working approach` section and the
construction-flow policy it encodes.

## Prompt control

`harness/prompt_generation.txt` is the official step-by-step generation prompt.
For the one-shot arm, `harness/run_pi_experiment.mjs` replaces only the section
from `## Working approach` through the text immediately before `## Rules` with
`harness/prompt_generation_one_shot.txt`.

The one-shot replacement is intentionally neutral:

- It treats the task as one integrated generation problem.
- It lets Pi autonomously decide analysis order, code organization, inspection
  timing, and refinement passes.
- It requires the initial geometry-changing `execute()` to represent the
  complete attempted model rather than a deliberately partial checkpoint.
- It does not provide the step-specific dimension-table, profile-first,
  checkpoint, dominant-form, iteration, or accuracy-pass workflow.

The test `harness/run_pi_experiment.test.mjs` enforces this prompt contract.
It checks the shared prefix and suffix and rejects leakage of the step-specific
workflow guidance into the one-shot baseline.

## Implementation map

- `harness/run_pi_experiment.mjs`
  Prepares an isolated run directory, renders the selected prompt, invokes Pi
  with isolated flags, captures the JSON stream and stderr, and records run
  metadata.

- `harness/pi_build123d_mcp.ts`
  Implements the Pi extension and JSON-RPC MCP client. It starts one
  build123d MCP process, registers the returned non-drawing tools with Pi, and
  keeps the process alive for the whole Pi session so `execute()` state
  persists across tool calls.

- `harness/prompt_generation.txt`
  Official step-by-step generation prompt used as the shared prompt base.

- `harness/prompt_generation_one_shot.txt`
  Replacement fragment for the one-shot `Working approach`.

- `harness/run_pi_experiment.test.mjs`
  Runner and prompt-isolation tests.

## Local layout

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

Temperature is currently configured in Pi's model settings rather than copied
into the runner command:

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

## Run one fixture

Run the step-by-step arm:

```powershell
node harness\run_pi_experiment.mjs `
  --fixture work\fixtures\118 `
  --work work\pi-runs\118-step `
  --variant step-by-step
```

Run the one-shot arm:

```powershell
node harness\run_pi_experiment.mjs `
  --fixture work\fixtures\118 `
  --work work\pi-runs\118-one-shot `
  --variant one-shot
```

Useful options:

- `--model provider/model:thinking`
- `--mcp-spec build123d-mcp==0.3.81`
- `--exec-timeout 300`
- `--pi path\to\pi\cli.js`
- `--extension path\to\pi_build123d_mcp.ts`
- `--provider-extension path\to\dashscope\extension`

## Run artifacts

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

## Current status and limitations

- The Pi bridge and persistent build123d MCP session are implemented.
- Prompt A/B isolation is implemented and tested.
- Fixture 118 step-by-step completed as a local smoke run and produced a valid
  STEP file.
- Formal sweeps, repeated trials, and official CADGenBench scoring/packaging
  are not yet wired for this Pi-only runner.
- The current experiment covers generation fixtures only; editing fixtures are
  not supported yet.
- Both arms receive the same non-drawing MCP tools, so tool access does not
  differ between arms. The bridge does not yet reproduce the official Claude
  driver's curated 17-tool allowlist.
- `run_meta.json` does not yet record the effective temperature or resolved
  MCP package version.
- Windows smoke testing uses a local worker fix in the sibling
  `build123d-mcp` checkout. The geometry workflow is unchanged, but provenance
  should disclose that local patch until it is upstreamed or committed here as
  a patch file.
