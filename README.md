# Pi Agent CADGenBench Workflow Experiment

This repository contains a focused Pi-only A/B experiment for CADGenBench
generation tasks. It is not a rerun of the official strongest harness.

## Research Question

With the same Pi runtime, model, fixture, build123d MCP tools, timeout, and
output contract, does an official-style semantic construction workflow improve
CAD generation over an explicit one-shot construction baseline?

| Arm | Variant | Prompt |
| --- | --- | --- |
| Pi Agent baseline | `pi-agent` | `harness/prompts/prompt_pi_agent.txt` |
| Pi Agent + step-by-step | `step-by-step` | `harness/prompts/prompt_step_by_step.txt` |

The two complete prompts are identical outside `Working approach`. Within that
section, only the construction stages differ; validation, inspection,
correction, checkpointing, and export remain shared.

## Architecture

```text
harness/
  runner/       Prepare an isolated workspace and launch Pi
  bridge/       Pi extension and persistent build123d MCP client
  prompts/      Complete one-shot and step-by-step prompts
  monitoring/   Read-only stream filter for live trajectory inspection
  dataset/      Fetch public CADGenBench fixtures
  evaluation/   Local validity, proxy shape scoring, and aggregation
docs/
  experiment-design.md
```

The runner starts Pi in JSON mode with only the model-provider extension and
the build123d bridge extension. The bridge starts one build123d MCP process,
registers its non-drawing tools with Pi, and keeps that process alive for the
session. Consequently, geometry created by `execute()` remains available to
later `validate()`, `render_view()`, `measure()`, correction, and `export()`
calls.

## Quickstart

```powershell
node harness\runner\run_pi_experiment.mjs `
  --fixture work\fixtures\118 `
  --work work\pi-runs\118-pi-agent `
  --variant pi-agent
```

For the treatment arm, use `--variant step-by-step` and a separate work
directory. While a run is active, monitor it from another terminal:

```powershell
python harness\monitoring\pi_stream_filter.py work\pi-runs\118-step-by-step --follow
```

## Tests

```powershell
node --test harness\runner\run_pi_experiment.test.mjs
python -m unittest discover -s harness\monitoring -p "pi_stream_filter_test.py" -v
cd ..\pi
node --test --import tsx ..\repo\harness\bridge\pi_build123d_mcp.test.ts
```

The detailed research design, controlled variables, implementation map, and
current limitations are in [docs/experiment-design.md](docs/experiment-design.md).
