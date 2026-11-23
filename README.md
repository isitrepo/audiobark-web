# AudioBark for iPhone (web version)

Made for the Dog Park Book Club, and for Honey Man. 🐾

An audiobook player that runs in Safari and installs to the iPhone home screen. No App Store, no cost.
Your books stay on your phone; nothing is uploaded anywhere.

## Install on an iPhone

1. Open the AudioBark link in **Safari**.
2. Tap **Share** (the square with an arrow), then **Add to Home Screen**, then **Add**.
3. Open AudioBark from the new dog-and-book icon on your home screen.

## Add a book

1. Get the book's audio files onto the phone first, somewhere the **Files** app can see
   (iCloud Drive, Google Drive, Downloads, AirDrop…).
2. In AudioBark tap **＋ Import book** and pick the files. For a folder of mp3s tap **Select → Select All**.
   Include a cover picture if you have one.
3. Check the title and tap **Import**. AudioBark keeps its own copy, so the book plays offline.

## Features

- `.m4b` / `.m4a` chapters, covers, titles and authors read from the files
- Remembers where you left off in every book, and your place in every chapter
- Jump 10 s / 1 min, tap the cover to play / pause, go to any chapter and time
- Speed per book, bookmarks, sleep timer (presets, custom length, end of chapter, shake to restart)
- Auto-rewind on resume, lock-screen controls (⏮ ⏭ skip 10 s), light / dark theme
- Works offline once added to the home screen

## Limits on iPhone

- Books must be imported (web apps can't read the phone's folders directly).
- Audio can't start itself when the car's Bluetooth reconnects; press play.
- Sleep timer fade-out and phone vibration aren't available in Safari; the timer just stops.

Plain HTML, CSS and JavaScript; no build step. Serve the folder from any static host (e.g. GitHub Pages).
