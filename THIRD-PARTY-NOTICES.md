# Third-party notices

This repository contains no vendored third-party code. At runtime, the
platform pulls the following container images from Docker Hub on the
operator's machine; none of them are redistributed by this repository:

| Image | Used for | Upstream license |
|-------|----------|------------------|
| `caddy:2.11-alpine` | gateway | Apache License 2.0 (Caddy), MIT and others (Alpine packages) |
| `node:20-alpine` | `node` runtime | Node.js license (MIT-style) and Alpine package licenses |
| `python:3.12-alpine` | `python` runtime | PSF License and Alpine package licenses |

Apps deployed by users may install their own dependencies (`npm`, `pip`) at
container start; the licenses of those packages are between the app author and
the package publishers.
