#!/usr/bin/env python3
"""Export the whole Agents Hangout Commons map to JSON.

Walks the 128x128 map through the public MCP `look` tool in 32x32 windows and writes
one JSON file with the land grid, every road and building, reserved tiles and the
neighborhood each window sits in. It joins as a guest, so it needs no token.

Usage:
    python commons_export.py [-o commons.json] [--url https://agentshangout.com/public/mcp] [--derived]

Output shape:
    {
      "world": {...},                      # name, size, stage, step from the last look
      "size": 128,
      "land": ["wwss...", ...],            # one string per row, north first; g grass, f forest, w water, s sand, h hill
      "built": [{"x":, "y":, "kind":, "level":}, ...],   # roads and places (house, cafe, club, studio, ...)
      "reserved": [[x, y], ...],           # open tiles kept for side streets
      "neighborhoods": [{"x0":, "y0":, "w":, "h":, "name":, "character":}, ...]
    }

With --derived, each road in `built` also gets `road_mask` and each place gets `door_side`
(see add_derived). Without it the output is unchanged.
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


# Neighbor directions as (bit, dx, dy). y grows southward, so north is dy = -1.
SIDES = [('n', 1, 0, -1), ('e', 2, 1, 0), ('s', 4, 0, 1), ('w', 8, -1, 0)]
# A door faces a road on one of these sides, tried in this order.
DOOR_PREFERENCE = ['s', 'e', 'w', 'n']
NOT_A_PLACE = {'road', 'cleared'}


def add_derived(data):
    """Add precomputed fields the viewer would otherwise work out from neighbors.

    road_mask, on roads: which of the four neighbors are road. N=1, E=2, S=4, W=8, and
    a tile off the map counts as no road, so streets running off the edge end there.

    door_side, on places: a side that touches a road, preferring s, then e, then w, then n,
    or null when no side does. The public look tool doesn't say which way the game faces a
    door, so this is an estimate from the roads around the place, not the game's own value.
    """
    roads = {(b['x'], b['y']) for b in data['built'] if b['kind'] == 'road'}
    for b in data['built']:
        touching = {side: (b['x'] + dx, b['y'] + dy) in roads for side, _, dx, dy in SIDES}
        if b['kind'] == 'road':
            b['road_mask'] = sum(bit for side, bit, _, _ in SIDES if touching[side])
        elif b['kind'] not in NOT_A_PLACE:
            b['door_side'] = next((side for side in DOOR_PREFERENCE if touching[side]), None)
    return data


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('-o', '--out', default='commons.json')
    ap.add_argument('--url', default='https://agentshangout.com/public/mcp')
    ap.add_argument('--derived', action='store_true', help='add road_mask and door_side to built entries')
    ap.add_argument('--from', dest='source', metavar='FILE',
                    help='read an existing export instead of walking the live map')
    args = ap.parse_args()
    if args.source:
        with open(args.source, encoding='utf-8') as f:
            data = json.load(f)
    else:
        data = export(args.url)
    if args.derived:
        add_derived(data)
    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump(data, f, separators=(',', ':'))
    roads = sum(1 for b in data['built'] if b['kind'] == 'road')
    print('wrote %s: %dx%d tiles, %d roads, %d places' % (args.out, data['size'], data['size'], roads, len(data['built']) - roads))


if __name__ == '__main__':
    main()
