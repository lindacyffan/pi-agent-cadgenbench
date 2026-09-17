# Body-Only Focus v1

This diagnostic prompt applies the stage-ablation focus factor to a primary-body-only
run. The agent focuses on the parts of `input.png` and the CAD model that belong to
the primary body, does not construct or plan later-stage geometry, verifies the body
at the end of the body stage, exports the body-only STEP file, and stops.
