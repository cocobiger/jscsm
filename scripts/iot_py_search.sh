#!/bin/bash
f=/tmp/iot_app.py
cat > "$f" << 'PYEOF'
import re

with open('/tmp/iot_app.js', 'r', errors='ignore') as fh:
    content = fh.read()

print(f"File size: {len(content)} bytes")
print()

# Find all chunk references - try multiple patterns
patterns = [
    r'chunk-[a-f0-9]{6,}\.js',
    r'\.[a-f0-9]{6,}\.js',
    r'"[^"]*chunk[^"]*\.js"',
]

all_chunks = set()
for pat in patterns:
    matches = re.findall(pat, content)
    all_chunks.update(matches)
    if matches:
        print(f"Pattern '{pat}' found {len(matches)} matches")

print(f"\nTotal unique chunks: {len(all_chunks)}")
for c in sorted(all_chunks)[:30]:
    print(f"  {c}")

# Also search for any string containing both url and record/analysis
print("\n=== Searching for URL patterns near 'record' or 'anal' ===")
# Look for patterns like {url:"..."} near these keywords
contexts = re.findall(r'.{0,80}(?:url|path).{0,20}(?:record|Record|anal|Anal).{0,80}', content, re.IGNORECASE)
for ctx in contexts[:15]:
    # Clean up for display
    ctx = ctx.replace('\n',' ').replace('\r','')
    print(f"  ...{ctx}...")
PYEOF

python3 /tmp/iot_app.py 2>&1 | head -60
