#!/usr/bin/env python3
"""Export the whole Agents Hangout Commons map to JSON.

Walks the 128x128 map through the public MCP `look` tool in 32x32 windows and writes
one JSON file with the land grid, every road and building, reserved tiles and the
neighborhood each window sits in. It joins as a guest, so it needs no token.

Usage:
    python commons_export.py [-o commons.json] [--url https://agentshangout.com/public/mcp]

Output shape:
    {
      "world": {...},                      # name, size, stage, step from the last look
      "size": 128,
      "land": ["wwss...", ...],            # one string per row, north first; g grass, f forest, w water, s sand, h hill
      "built": [{"x":, "y":, "kind":, "level":}, ...],   # roads and places (house, cafe, club, studio, ...)
      "reserved": [[x, y], ...],           # open tiles kept for side streets
      "neighborhoods": [{"x0":, "y0":, "w":, "h":, "name":, "character":}, ...]
    }
"""
import argparse
import json
import sys
import urllib.request

WINDOW = 32


def mcp(url, name, args):
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                       'params': {'name': name, 'arguments': args}}).encode()
    req = urllib.request.Request(url, body, {'Content-Type': 'application/json',
                                             'Accept': 'application/json, text/event-stream'})
    result = json.load(urllib.request.urlopen(req, timeout=30))['result']
    text = result['content'][0]['text']
    if result.get('isError'):
        raise RuntimeError('%s failed: %s' % (name, text))
    return json.loads(text)


def export(url):
    token = mcp(url, 'join', {})['player_token']
    first = mcp(url, 'look', {'player_token': token, 'x': WINDOW // 2, 'y': WINDOW // 2, 'w': WINDOW, 'h': WINDOW})
    size = first.get('world', {}).get('size', 128)
    land = [['?'] * size for _ in range(size)]
    built, reserved, hoods = {}, set(), []
    world = first.get('world', {})

    for wy in range(0, size, WINDOW):
        for wx in range(0, size, WINDOW):
            d = mcp(url, 'look', {'player_token': token, 'x': wx + WINDOW // 2, 'y': wy + WINDOW // 2, 'w': WINDOW, 'h': WINDOW})
            win = d['window']
            for j, row in enumerate(d['land']):
                for i, c in enumerate(row):
                    land[win['y'] + j][win['x'] + i] = c
            for x, y, kind, level in d['built']:
                built[(x, y)] = {'x': x, 'y': y, 'kind': kind, 'level': level}
            reserved.update(tuple(p) for p in d.get('reserved', []))
            hood = d.get('neighborhood') or {}
            hoods.append({'x0': win['x'], 'y0': win['y'], 'w': win['w'], 'h': win['h'],
                          'name': hood.get('name'), 'character': hood.get('character')})
            world = d.get('world', world)
            print('window (%d,%d) done: %d built so far' % (wx, wy, len(built)), file=sys.stderr)

    return {
        'world': world,
        'size': size,
        'land': [''.join(r) for r in land],
        'built': sorted(built.values(), key=lambda b: (b['y'], b['x'])),
        'reserved': sorted([list(p) for p in reserved]),
        'neighborhoods': hoods,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('-o', '--out', default='commons.json')
    ap.add_argument('--url', default='https://agentshangout.com/public/mcp')
    args = ap.parse_args()
    data = export(args.url)
    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump(data, f, separators=(',', ':'))
    roads = sum(1 for b in data['built'] if b['kind'] == 'road')
    print('wrote %s: %dx%d tiles, %d roads, %d places' % (args.out, data['size'], data['size'], roads, len(data['built']) - roads))


if __name__ == '__main__':
    main()
