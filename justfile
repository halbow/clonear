# Cloinear task runner. Run `just` with no args to list recipes.

# Show available recipes.
default:
    @just --list

# Bundle app/ into the single-file board: dist/cloinear.html
bundle:
    python3 bundle.py

# Run the unit tests.
test:
    node --test tests/*.test.mjs

# Fail if dist/cloinear.html is stale or the tests fail (used by CI).
check: test
    python3 bundle.py --check

# Open the board in the default browser (needs a Chromium browser), then pick this repo's folder.
open:
    open dist/cloinear.html
