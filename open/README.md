# CNVS app links

A web link that opens the CNVS phone app.

```
https://goozie07.github.io/cnvs-review/open/                     opens the app
https://goozie07.github.io/cnvs-review/open/?to=review&t=abc     opens cnvs://review?t=abc
```

`to` is the screen in the app. Every other parameter is passed on to the app unchanged.

- **On a phone**, the page opens the app straight away. If the app doesn't open, the page shows an
  **Open in CNVS** button and help text.
- **On a computer**, the page shows a QR code to scan with your phone, plus a field for building links
  to a particular screen.

## Settings

These are at the top of the script in `index.html`:

| Setting             | What it is                                                          |
| ------------------- | ------------------------------------------------------------------- |
| `scheme`            | The app's URL scheme. Default `cnvs`, which opens `cnvs://…` links. |
| `androidPackage`    | The Android package name (optional).                                |
| `iosInstallUrl`     | An App Store or TestFlight link, shown when the app doesn't open.   |
| `androidInstallUrl` | A Play Store link, shown when the app doesn't open.                 |
| `autoOpen`          | Whether a phone tries to open the app as soon as the page loads.    |

## What the app needs

The app has to register the same URL scheme, or the phone won't know which app handles the link:

- **iOS (Xcode):** go to Target › Info › URL Types, add one, and set URL Schemes to `cnvs`.
- **Expo / React Native:** set `"scheme": "cnvs"` in `app.json`.
- **Android:** add an intent filter with `<data android:scheme="cnvs" />` on the main activity.

When a link names a screen (`?to=review`), the app reads the incoming URL and goes to that screen.

## Files

- `index.html`: the page.
- `qrcode.js`: QR code generator by Kazuhiko Arase, MIT licence, from qrcode-generator 2.0.4 on npm.
- `logo.png`: the CANVAS logo.
- `og.png`: the preview image WhatsApp and iMessage show when the link is shared.
