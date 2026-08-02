# smevals selfbench prototype

This directory tests whether `smevals` can provide a standard experiment and
reporting layer around the existing CADGenBench harness. It deliberately does
not replace fixture fetching, model execution, or geometry scoring.

The default config replays three existing artifacts, so the integration and
grader can be exercised without model cost:

```bash
uv tool run --from smevals smevals run experiments/smevals-selfbench -g
uv tool run --from smevals smevals report experiments/smevals-selfbench --by-task
```

The live config delegates each task to the existing harness using MCP 0.3.79:

```bash
uv tool run --from smevals smevals run experiments/smevals-selfbench -c live -g
```

Override the live model with one or more `-m` options. The model identifier may
include the harness effort suffix, such as `claude-opus-5:xhigh` or
`gpt-5.6-sol:xhigh`.

Each immutable smevals run retains `output.step`; live runs also retain the
driver log and filtered agent transcript. The grader invokes the same pinned
CADGenBench shape-similarity implementation used by `selfbench/local_score.py`.
It scores a workspace copy with fixed Python and NumPy seeds, so the scorer's
aligned STEP is retained as a Grade artifact and cannot modify the immutable
Run. The underlying multiprocessing/ICP implementation still shows small
regrade variance (about 0.0002-0.0036 on this smoke set), which repeated-run
analysis or a deterministic scorer mode must account for.
After changing the grader, re-evaluate existing artifacts without another model
run:

```bash
uv tool run --from smevals smevals grade experiments/smevals-selfbench --regrade
```

This prototype does not yet cover repeated-run pairing, bootstrap confidence
intervals, public generation/edit aggregate scores, or package validation.
