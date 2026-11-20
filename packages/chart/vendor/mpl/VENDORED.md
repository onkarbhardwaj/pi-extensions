# Vendored mpljs

- **Source:** https://github.com/ivarvong/mpl
- **Commit:** 117503cc96a3a9ec583e90a97026b720c0699d5d
- **License:** ISC (`LICENSE`); bundled fonts (Inter, DejaVu) per `THIRD_PARTY_NOTICES.md`.
- **Contents:** the `.js` files of `dist/browser` only, unmodified.

To refresh:

```sh
git clone https://github.com/ivarvong/mpl /tmp/mpl && cd /tmp/mpl
npm ci --ignore-scripts && node scripts/build_package.ts   # works on Node 22.18+ as well as 24
rm -rf <repo>/packages/chart/vendor/mpl/{*.js,core,render,fonts,colormaps,interactive}
cd dist/browser && find . -name '*.js' -exec install -D {} <repo>/packages/chart/vendor/mpl/{} \;
```

Then update the commit above and run `npm test -w packages/chart`.
