Build a small Python CLI named `csvsummary.py` using only the standard library.

- Read a CSV file from a positional argument, or stdin when no file is given.
- Print JSON with `rows`, `columns` (the header names), and `numeric_totals`.
- Sum a column only when every non-empty value is a finite number. Ignore empty
  cells; omit columns with no numbers. Reject rows with the wrong number of cells.
- Provide `--help` and useful errors with nonzero exit codes.
- Add `test_csvsummary.py` covering files, stdin, empty input, quoted fields,
  missing values, non-numeric columns, and malformed rows. Run `python3 -m unittest -v`.
- Verify `sales.csv` reports 3 rows, columns `name` and `amount`, and an amount
  total of 35.5. Add a short README with usage and test commands.

Finish only after the tests and the sample command pass.
