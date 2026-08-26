import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCube, writeCube, toLut3D, CubeParseError } from '../dist/lut/cube.js';

function identityCube(size) {
  const values = [];
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++)
        values.push(r / (size - 1), g / (size - 1), b / (size - 1));
  return values;
}

test('round-trips a 3D cube', () => {
  const size = 5;
  const text = writeCube(size, identityCube(size), { title: 'Round trip' });
  const parsed = parseCube(text);
  assert.equal(parsed.kind, '3D');
  assert.equal(parsed.size, size);
  assert.equal(parsed.title, 'Round trip');
  assert.equal(parsed.data.length, size ** 3 * 3);
  assert.ok(Math.abs(parsed.data[0]) < 1e-6);
  assert.ok(Math.abs(parsed.data[parsed.data.length - 1] - 1) < 1e-6);
});

test('tolerates CRLF, BOM, comments, tabs and blank lines', () => {
  const text =
    '﻿# a comment\r\n' +
    'TITLE "Messy"\r\n' +
    '\r\n' +
    'LUT_3D_SIZE 2\r\n' +
    '\t0.0\t0.0\t0.0\r\n' +
    '1 0 0   # inline comment\r\n' +
    '0 1 0\r\n' +
    '1 1 0\r\n' +
    '0 0 1\r\n' +
    '1 0 1\r\n' +
    '0 1 1\r\n' +
    '1 1 1\r\n' +
    '\r\n';
  const lut = parseCube(text);
  assert.equal(lut.size, 2);
  assert.equal(lut.title, 'Messy');
  assert.equal(lut.data.length, 24);
});

test('rejects a cube whose row count does not match its declared size', () => {
  const text = 'LUT_3D_SIZE 3\n0 0 0\n1 1 1\n';
  assert.throws(() => parseCube(text), CubeParseError);
});

test('rejects a file with no size declaration', () => {
  assert.throws(() => parseCube('0 0 0\n1 1 1\n'), CubeParseError);
});

test('promotes a 1D LUT to an equivalent 3D cube', () => {
  // A 1D LUT that inverts each channel.
  const lines = ['LUT_1D_SIZE 2', '1 1 1', '0 0 0'];
  const lut1d = parseCube(lines.join('\n'));
  assert.equal(lut1d.kind, '1D');

  const lut3d = toLut3D(lut1d);
  assert.equal(lut3d.kind, '3D');

  // Black in must come out white.
  assert.ok(Math.abs(lut3d.data[0] - 1) < 1e-6);
  // White in must come out black.
  const last = lut3d.data.length - 3;
  assert.ok(Math.abs(lut3d.data[last]) < 1e-6);
});

test('writeCube refuses a mismatched value count', () => {
  assert.throws(() => writeCube(3, [0, 0, 0]), /Expected 81 values/);
});
