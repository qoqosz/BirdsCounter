# License

BirdsCounter is released under the MIT License.

## MIT License

Copyright (c) 2026 Łukasz Bednarski

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Third-party software

The MIT License covers BirdsCounter's own code. The libraries it uses keep their own licenses, all of which allow
use in an MIT-licensed project:

| Component | License |
| --- | --- |
| [OpenCV](https://opencv.org/) (linked into the apps) | Apache-2.0 |
| [OpenCV.js](https://www.npmjs.com/package/@techstark/opencv-js) (web version) | Apache-2.0 |
| [Tauri](https://tauri.app/) and its plugins | MIT OR Apache-2.0 |
| [opencv-rust](https://github.com/twistedfall/opencv-rust) | MIT |
| [swift-rs](https://github.com/Brendonovich/swift-rs) (patched copy in `src-tauri/vendor/swift-rs`) | MIT OR Apache-2.0 |
| Other Rust crates | MIT, Apache-2.0, BSD, ISC, Zlib, Unicode-3.0 or MPL-2.0 (unmodified) |

The full license texts of these components ship with their sources, for example in `src-tauri/vendor/swift-rs` and in
each crate's package.
