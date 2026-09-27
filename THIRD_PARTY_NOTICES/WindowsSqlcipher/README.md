# Independent Windows SQLCipher reader

The Windows database reader uses `better-sqlite3-multiple-ciphers` **13.0.3**, with SQLite **3.53.4** and SQLite3 Multiple Ciphers **2.4.0**. The exact package and registry integrity are pinned in `package-lock.json`. These open-source components replace the Windows reader's dependency on `wcdb_api.dll` and its license service.

- [better-sqlite3-multiple-ciphers 13.0.3](https://github.com/m4heshd/better-sqlite3-multiple-ciphers/releases/tag/v13.0.3): MIT, copyright Mahesh Bandara Wijerathna and Joshua Wise. The accompanying [LICENSE](LICENSE) is copied unmodified from the installed npm package; the package's own `LICENSE` is retained when packaged.
- [SQLite3 Multiple Ciphers 2.4.0](https://github.com/utelle/SQLite3MultipleCiphers/tree/v2.4.0): MIT, copyright Ulrich Telle. See the [upstream license](https://github.com/utelle/SQLite3MultipleCiphers/blob/v2.4.0/LICENSE) and [local copy](SQLITE3MC-LICENSE). Its amalgamation also retains the component-level copyright and license notices in `deps/sqlite3/sqlite3.c` in the npm source package.
- [SQLite](https://sqlite.org/copyright.html): public domain.
- SQLCipher is the compatible database format selected in SQLite3 Multiple Ciphers. See the [cipher implementation documentation](https://utelle.github.io/SQLite3MultipleCiphers/docs/ciphers/cipher_sqlcipher/) and [SQLCipher upstream license](https://github.com/sqlcipher/sqlcipher/blob/master/LICENSE.md). Selecting this compatibility mode does not load the application's proprietary WCDB license bridge.
- The Node-API build dependency is [node-addon-api](https://github.com/nodejs/node-addon-api), MIT; its package retains its own [upstream license](https://github.com/nodejs/node-addon-api/blob/main/LICENSE.md).

The native package uses Node-API and publishes Windows x64 prebuilds for Node.js 22+ / Electron 35+. The application currently targets Electron 39. Windows packaging keeps `prebuilds/win32-x64.node`, its JavaScript loader, package metadata and license outside ASAR. Runtime availability is checked by loading the native binding without opening a database.

Implementation and verification notes: [Windows reader](../../docs/windows-sqlcipher.md).
