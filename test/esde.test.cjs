const { test } = require("node:test");
const assert = require("node:assert/strict");
const esde = require("../esde.cjs");

test("media and gamelist locations follow the ES-DE layout", () => {
  const rom = "/storage/ABCD-1234/ROMs/nds/Racing/Mario Kart DS.nds";
  const romPath = esde.romPathInSystem(rom, "/storage/ABCD-1234/ROMs", "nds");
  assert.equal(romPath, "Racing/Mario Kart DS.nds");
  assert.equal(
    esde.mediaTarget("/storage/ABCD-1234/ES-DE", "nds", romPath, "cover", ".png"),
    "/storage/ABCD-1234/ES-DE/downloaded_media/nds/covers/Racing/Mario Kart DS.png",
  );
  assert.equal(
    esde.gamelistPath("/storage/ABCD-1234/ES-DE/", "nds"),
    "/storage/ABCD-1234/ES-DE/gamelists/nds/gamelist.xml",
  );
  assert.equal(esde.romPathInSystem("/sdcard/Other/x.nds", "/storage/ABCD-1234/ROMs", "nds"), "");
  assert.equal(esde.esdeDate("2005"), "20050101T000000");
  assert.equal(esde.esdeDate("2005-11-14"), "20051114T000000");
});

test("gamelist merge updates only our games and keeps everything else", () => {
  const existing = `<?xml version="1.0"?>
<gameList>
	<game>
		<path>./Other Game.nds</path>
		<name>Someone else's entry</name>
		<favorite>true</favorite>
	</game>
	<game>
		<path>./Mario Kart DS.nds</path>
		<name>Old name</name>
		<playcount>12</playcount>
	</game>
</gameList>
`;
  const merged = esde.mergeGamelist(existing, [
    {
      path: "./Mario Kart DS.nds",
      fields: { name: "Mario Kart DS", developer: "Nintendo EAD & Co" },
    },
    { path: "./New Super Mario Bros.nds", fields: { name: "New Super Mario Bros." } },
  ]);
  assert.match(
    merged,
    /<name>Someone else's entry<\/name>\s*<favorite>true<\/favorite>/,
    "other games untouched",
  );
  assert.match(merged, /<name>Mario Kart DS<\/name>/);
  assert.match(merged, /<playcount>12<\/playcount>/, "tags we do not manage are kept");
  assert.match(merged, /<developer>Nintendo EAD &amp; Co<\/developer>/, "values are escaped");
  assert.match(merged, /<path>\.\/New Super Mario Bros\.nds<\/path>/, "new games are added");
  assert.equal((merged.match(/<game>/g) || []).length, 3);
  const fresh = esde.mergeGamelist("", [{ path: "./a.nds", fields: { name: "A" } }]);
  assert.match(
    fresh,
    /^<\?xml version="1\.0"\?>\n<gameList>\n\t<game>\n\t\t<path>\.\/a\.nds<\/path>/,
  );
});

test("gamelist fields come from the scraped metadata", () => {
  assert.deepEqual(
    esde.gameFields({
      title: "X",
      description: "",
      developer: "D",
      releaseDate: "1999",
      rating: 0.85,
    }),
    {
      name: "X",
      developer: "D",
      releasedate: "19990101T000000",
      rating: "0.85",
    },
  );
});
