# smevals selfbench experiments

This directory provides an experimental `smevals` orchestration and reporting
layer around the existing CADGenBench harness. It deliberately does not replace
fixture fetching, model execution, or geometry scoring.

## Replay the dimension-chain A/B

The baseline and treatment configs replay all 14 saved artifacts without model
cost:

```bash
uv tool run --from smevals==0.2.0 smevals run experiments/smevals-selfbench -c baseline
uv tool run --from smevals==0.2.0 smevals run experiments/smevals-selfbench -c treatment
uv tool run --from smevals==0.2.0 smevals grade experiments/smevals-selfbench -g saved
uv tool run --from smevals==0.2.0 smevals report experiments/smevals-selfbench -g saved --by-task
experiments/smevals-selfbench/paired-report --a baseline --b treatment --grader saved
```

Replay runs retain the original `run_meta.json`, dirty patch, and a normalized
`provenance.json` containing model, effort, MCP, timeout, git commit, patch hash,
and STEP hash.

## Run a live config

The live config delegates each task to the existing harness using MCP 0.3.79:

```bash
uv tool run --from smevals==0.2.0 smevals run experiments/smevals-selfbench -c live -g
```

Override the model with one or more `-m` options. The model identifier may
include the harness effort suffix, such as `claude-opus-5:xhigh` or
`gpt-5.6-sol:xhigh`. Live provenance records model, effort, MCP spec, timeout,
git state, prompt hash, and STEP hash.

## Grade and compare

Each immutable smevals run retains `output.step`; live runs also retain the
driver log and filtered agent transcript. The grader invokes the same pinned
CADGenBench shape-similarity implementation used by `selfbench/local_score.py`.
It scores a workspace copy with fixed Python and NumPy seeds, so the aligned
STEP is retained as a Grade artifact and cannot modify the immutable Run.

There are two graders with distinct meanings:

- `saved` imports the original score evidence recorded with each replay source.
  Use it for historical A/B analysis and exact parity checks.
- `default` recomputes geometry scores with the current pinned scorer. Use it
  to test scorer changes or newly generated outputs.

The underlying multiprocessing/ICP implementation is not deterministic. Across
the full 14-fixture A/B, recomputation moved six fixtures per side by more than
0.01 and up to about 0.034. Never mix saved and recomputed grades in one A/B.

Re-evaluate existing artifacts without another model run:

```bash
uv tool run --from smevals==0.2.0 smevals grade experiments/smevals-selfbench -g default --regrade
```

Check regraded scores against the original saved score documents:

```bash
experiments/smevals-selfbench/parity-report \
  --config baseline \
  --source selfbench/scores/dimension-chain-all-medium-baseline-r1.json
experiments/smevals-selfbench/parity-report \
  --config treatment \
  --source selfbench/scores/dimension-chain-all-medium-treatment-r1.json
```

`paired-report` averages repeated grades within each task/config, computes the
paired treatment-minus-baseline delta, standard error, and a seeded bootstrap
95% confidence interval. It defaults to the `saved` grader and accepts
`--grader default` for explicit recomputation analysis. If a config contains
more than one model, select an exact model token with `--model`; the tool will
not average different models together. Artifact checks tag runner failures,
missing output, and missing provenance separately; scoring tags distinguish
invalid STEP, scorer timeout, and other scorer errors where the exception
permits.

This workflow does not yet cover public generation/edit aggregate scores or
package validation. HF scoring remains authoritative for submissions.
