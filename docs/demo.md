# Demo: from a goal to tested code

The [README animation](demo.gif) uses actual command output from a Sail run on
October 29, 2026. Screens are arranged for readability and waiting time is shortened.
Separate terminal-control checks are omitted. The animation is an edited recording,
not a promise about execution time or the code another run will produce.

## Try it

Copy [GOAL.md](../examples/csv-summary/GOAL.md) and
[sales.csv](../examples/csv-summary/sales.csv) into an empty directory. Set
`SAIL_API_KEY`, enter that directory, and run:

```sh
longshot start --file GOAL.md --budget 2
longshot status
```

The goal asks OpenCode to build a Python CLI that summarizes CSV files as JSON,
handles files and stdin, reports malformed input, and tests its behavior. Python
is already available inside the Sailbox. Running the exported example locally
requires Python 3.

The agent works remotely. You can close the terminal and return later. Once
`status` reports `Goal: complete` and `Execution: idle`:

```sh
longshot export --output ./result
cd result/workspace
python3 csvsummary.py sales.csv
python3 -m unittest -q
cd ../..
longshot destroy --yes
```

The recorded run returned 3 rows, columns `name` and `amount`, and an amount total
of 35.5. Its 20 tests passed again after export. We also checked 100 independent
CSV inputs locally. Destruction removed the Sailbox and its run-specific secret
and policy; the exported files remained available.

The optional $2 budget estimates inference usage. It does not include compute
or guarantee a hard dollar ceiling. Destroy the Sailbox when you are done.

## Rendering the GIF

[demo.cast](demo.cast) contains the edited terminal recording. Render it with
[agg](https://github.com/asciinema/agg) (recorded with version 1.9.0):

```sh
agg --theme github-dark --font-family Menlo --font-size 16 \
  --fps-cap 15 --idle-time-limit 10 --last-frame-duration 2 \
  docs/demo.cast docs/demo.gif
```

Use another installed monospace font if Menlo is unavailable. The renderer is
only needed to update the animation; it is not a Longshot dependency.
