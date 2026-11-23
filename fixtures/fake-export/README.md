# Fake export fixture

`fake-extended-history.json` is fake. Every artist, album, track and episode in it is invented, and no row is real listening data.

The keys are unverified guesses. They are the Extended Streaming History names that the ingest repository's `src/mapping.ts` assumes, and no real export has confirmed them yet. If a real export uses other names, change that mapping and edit this file by hand. A script did not write it and none keeps it in step, so it is a fixed example.

The file holds only the keys the mapping reads. Private fields such as addresses, country and device are left out entirely.

It has one podcast row, one private-session row, rows with no album, and short plays, so an importer can show how it drops or keeps each kind.
