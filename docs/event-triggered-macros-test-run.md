# Event-Macros ausprobieren und verstehen — Anleitung für Einsteiger

Diese Anleitung erklärt die neue "Event Macros"-Funktion so, dass du sie nachvollziehen kannst, auch
wenn du weder G-Code noch die Technik dahinter kennst. Zu jedem Punkt bekommst du drei Dinge:

- **Situation** — wann/wofür man das im echten Betrieb braucht
- **Problem** — was dabei schiefgehen könnte, wenn man es "naiv" bauen würde
- **Lösung** — was wir eingebaut haben, damit genau das nicht passiert, und wie du das selbst nachprüfst

## Was macht die Funktion überhaupt?

Event Macros lassen die Weboberfläche (die Seite, die du im Browser siehst, wenn du `192.168.30.2`
aufrufst) automatisch einen Befehl an ein ANDERES Gerät in deinem Netzwerk schicken, sobald an deiner
Fräse/deinem Laser etwas Bestimmtes passiert — z.B. "sobald die Spindel anläuft, schalte die
Staubabsaugung ein". In dieser Anleitung sind das zwei WLAN-Steckdosen-Stecker (Tasmota), die du auch
schon aus deinen normalen Macros kennst:

- **"Vac"** (Staubsauger), `192.168.30.4` — `http://192.168.30.4/cm?cmnd=Power%20ON` schaltet ihn ein,
  `...Power%20OFF` aus.
- **"Fräse"** (Hauptstrom der Maschine/des Spindelmotors — NICHT der ESP32-Controller selbst, der bleibt
  separat versorgt, sonst könntest du diese Seite ja gar nicht bedienen), `192.168.30.3` —
  `http://192.168.30.3/cm?cmnd=Power%201` schaltet sie ein, `...Power%200` aus (dieselbe Tasmota-Technik,
  nur mit `1`/`0` statt `ON`/`OFF` geschrieben — beides ist gleichwertig, hier einfach genau wie in
  deinem schon vorhandenen "Fräse"-Macro).

Hier passiert das Schalten nur automatisch statt per Knopfdruck.

**Zwei Begriffe, die überall auftauchen:**
- **"Ereignis" (Event)** — ein Zustandswechsel an der Maschine, den die Oberfläche erkennt: Spindel an/
  aus, Tür auf/zu, Alarm ausgelöst, usw.
- **"Regel"** — was du in den Einstellungen anlegst: "wenn Ereignis X passiert, schick diese URL".

**Sicherheitshinweis:** alles unten, was die Spindel dreht oder die Maschine bewegt, machst du selbst am
Gerät — aus der Ferne wird hier nichts angestoßen.

## Vorbereitung (einmalig)

1. `Strg+F5` im Browser auf `192.168.30.2` (das lädt die Seite komplett neu, nicht nur aus dem
   Zwischenspeicher — wichtig nach jedem Update).
2. Gehe zu **Settings → Interface** und scrolle runter zu **"Event Macros"** (eigene Sektion, in der
   Nähe von "Macros"/"Polling"). **Screenshot #1** — zeigt die neue Sektion mit dem Hauptschalter aus
   und leerer/versteckter Liste.
3. Aktiviere den Schalter **"Enable event macros"** ganz oben in dieser Sektion — das ist der
   **Hauptschalter**: solange er aus ist, passiert überhaupt nichts, egal welche Regeln du anlegst. Nach
   dem Aktivieren erscheint darunter die Liste, in der du Regeln anlegen kannst.
4. Öffne die Browser-Konsole (Taste `F12`) und darin den **Network-Tab** (Filter auf `cm` oder auf
   `192.168.30.4` eintippen). Das ist dein Hauptbeweis während der ganzen Anleitung: jedes Mal, wenn eine
   Regel feuert, siehst du hier eine neue Zeile mit der URL, die verschickt wurde.

## Schnellstart: Vorlagen statt selbst tippen

Du musst die Regeln nicht selbst eintippen — neben dem "+"-Knopf zum manuellen Anlegen einer Regel gibt
es vier **Vorlagen-Buttons**. Ein Klick legt eine fertige, sofort testbare Regel (oder ein Regel-Paar)
an, mit allen Werten schon korrekt ausgefüllt. Auf jeden Button hovern zeigt eine kurze Erklärung. Jede
angelegte Regel bleibt danach ganz normal bearbeitbar, falls du z.B. eine andere Adresse eintragen
willst.

- **"Staubsauger"** — siehe Test 1. `spindle_on` → Sauger an; `cycle_stop` → Sauger aus (nicht
  `spindle_off` — dazu gleich mehr).
- **"Türsicherung"** — siehe Test 7. `door_open` → Fräse UND Sauger aus; `door_closed` → beide wieder an.
- **"Alarm-Absicherung"** — siehe Test 9. `alarm` → Fräse UND Sauger sofort aus.
- **"Fräse-Sync"** — siehe Test 15. `cycle_start` → Fräse an (sofort); `cycle_stop` → Fräse aus (mit 15
  Sekunden Verzögerung).

Für `hold`, `ws_connect`, `ws_disconnect` gibt es bewusst keine Vorlage — deren Beispiel-Adressen sind
nur Platzhalter und würden ohne eigene Anpassung nicht funktionieren; die trägst du bei Bedarf über das
normale "+"-Formular ein (der Blitz-Knopf neben dem Adressfeld füllt dir dort zumindest die
Beispieladresse für das gewählte Ereignis vor).

**Warum "Staubsauger" nicht mehr `spindle_off` nutzt:** am Ende eines Fräs-Programms läuft typischerweise
eine ganze Abfolge — Spindel aus, dann hochfahren, dann in die Parkposition fahren, erst dann ist das
Programm wirklich fertig. `spindle_off` feuert schon beim ALLERERSTEN Schritt dieser Abfolge (sobald `M5`
ausgeführt wird) — der Sauger würde also ausgehen, während die Maschine noch unterwegs zur Parkposition
ist. `cycle_stop` dagegen feuert erst, wenn die Maschine wirklich komplett fertig ist (Gesamtzustand
wechselt von "läuft" zu "steht still", also NACHDEM die ganze Abfolge durchgelaufen ist) — das ist der
Zeitpunkt, an dem du den Sauger wirklich abschalten willst.

**Bewusst nicht gebaut:** eine Vorlage, die die Fräse an `ws_connect`/`ws_disconnect` koppelt — das wäre
reine Browser-Tab-Angelegenheit (siehe Test 10), zu überraschend/riskant für den Hauptstrom der Maschine.
`ws_connect`/`ws_disconnect` eignen sich eher für unkritische Zusatzgeräte (Arbeitsplatzbeleuchtung,
Lüftung) — dafür fehlt aktuell noch eine echte, verifizierte Geräteadresse.

## Test 1: Spindel an → Steckdose an, Programm wirklich fertig → Steckdose aus (die Haupt-Demo)

**Situation:** Im echten Betrieb soll die Staubabsaugung automatisch angehen, sobald die Spindel (der
Fräsmotor) läuft, und erst wieder ausgehen, wenn das ganze Programm — inklusive Hochfahren und Parken am
Ende — wirklich komplett fertig ist.

**Problem:** Am Ende eines Programms passiert typischerweise eine ganze Abfolge: Spindel aus, dann
hochfahren, dann in die Parkposition fahren. Würde die Absaugung schon beim allerersten Schritt (Spindel
aus) abschalten, liefe sie nicht mehr, während die Maschine noch unterwegs zur Parkposition ist — genau
dann könnte aber noch Staub aufgewirbelt werden.

**Lösung:** Das Einschalten reagiert sofort auf die Spindel (`spindle_on`) — Absaugung soll ja sofort da
sein, wenn geschnitten wird. Das Ausschalten dagegen ist an ein anderes Ereignis gebunden,
`cycle_stop` — das feuert erst, wenn die Maschine als Ganzes wieder "steht" (nicht mehr "läuft"), also
NACHDEM die komplette Hochfahren-und-Parken-Abfolge durchgelaufen ist.

**So legst du die Regeln an:** einfach oben auf den Vorlagen-Button **"Staubsauger"** klicken (siehe
"Schnellstart" oben) — das legt automatisch genau diese beiden Zeilen an:

| Ereignis (Dropdown) | Ziel-URL | Verzögerung (delay, in ms) | Mindestabstand (cooldown, in ms) |
|---|---|---|---|
| Spindle turns on | `http://192.168.30.4/cm?cmnd=Power%20ON` | 300 | 3000 |
| Cycle stop | `http://192.168.30.4/cm?cmnd=Power%20OFF` | 300 | 3000 |

(Willst du es stattdessen von Hand nachvollziehen: "+"-Knopf zum Anlegen einer neuen Zeile, zweimal,
Werte wie in der Tabelle eintragen.)

**So testest du es:** Öffne das **Terminal-Panel** (dort tippst du Befehle direkt an die Steuerung — die
sogenannte "G-Code"-Sprache, die jede CNC-Steuerung versteht). Tippe:
```
M3 S1000
```
`M3` heißt "Spindel einschalten (im Uhrzeigersinn)", `S1000` heißt "mit 1000 Umdrehungen pro Minute". →
Nach ca. 300ms sollte die Steckdose angehen (im Network-Tab siehst du eine Anfrage an `.../Power%20ON`).

**Wichtig für den Aus-Test:** ein bloßes `M5` (Spindel aus) reicht diesmal NICHT, weil `cycle_stop` den
Gesamtzustand der Maschine braucht, nicht nur die Spindel — die Steuerung muss tatsächlich "laufen"
(Bewegung ausführen), nicht nur die Spindel drehen lassen. Tippe stattdessen eine kleine
Bewegungsabfolge, die eine echte Spindel-aus-dann-Bewegung nachstellt, z.B.:
```
M3 S1000
G0 X10
M5
G0 X0
```
Nach der letzten Zeile (`G0 X0`, Rückfahrt — steht dann für "zurück in Parkposition") sollte die Steckdose
ausgehen, sobald die Steuerung wieder in den Ruhezustand ("Idle") wechselt — üblicherweise binnen
Sekundenbruchteilen nach der letzten Bewegung.

**Für den PR:** kurzes Video (20-30s), das zeigt: `M3` tippen → Steckdose an → kurze Bewegungsabfolge wie
oben → Steckdose geht erst nach der letzten Bewegung aus, nicht schon beim `M5`.

## Test 2: Eingabe-Prüfung in den Einstellungen

**Situation:** Du legst eine neue Regel an und tippst z.B. aus Versehen eine falsche oder unsichere
Adresse ein, oder lässt ein Feld leer.

**Problem:** Ohne Prüfung würdest du das erst beim Testen am echten Gerät merken — die Regel würde
einfach lautlos nicht funktionieren, ohne dass klar wäre, warum.

**Lösung:** Das Formular prüft deine Eingaben direkt beim Tippen und markiert Fehler sofort, bevor du
überhaupt speicherst.

**So testest du es:**
- Neue Regel anlegen, das Trigger-Dropdown (Ereignis-Auswahl) öffnen → **Screenshot #2**, zeigt alle 10
  übersetzten Ereignis-Namen.
- Das URL-Feld leer lassen oder `ftp://...` eintippen → roter Rand/Fehlermeldung erscheint. Tippst du
  stattdessen eine echte `http://...`-Adresse ein, verschwindet der Fehler wieder.
- Den Mindestabstand (cooldown) auf `100` setzen → sollte automatisch auf `500` (die Untergrenze)
  zurückspringen bzw. einen Fehler zeigen.
- Mit der Maus über das Trigger-Dropdown fahren (hovern) → ein Tooltip mit einer Erklärung erscheint,
  z.B. wann genau "Spindle turns on" auslöst — **Screenshot #3**.

## Test 3: Der Hauptschalter schaltet wirklich alles ab

**Situation:** Du willst die ganze Funktion vorübergehend komplett deaktivieren — z.B. weil du gerade
etwas anderes testest und keine automatischen Aktionen willst — ohne jede einzelne Regel mühsam zu
löschen.

**Problem:** Ohne einen zentralen Schalter müsstest du jede Regel einzeln deaktivieren und später wieder
aktivieren — fehleranfällig und umständlich.

**Lösung:** Der Schalter **"Enable event macros"** aus der Vorbereitung ist genau dafür da: aus = nichts
feuert, egal was an der Maschine passiert; an = alles funktioniert wieder normal, ohne dass du die Seite
neu laden musst.

**So testest du es:** Schalte "Enable event macros" aus, tippe im Terminal nochmal `M3 S1000` und `M5` →
im Network-Tab passiert nichts, keine Anfrage. Schalte ihn wieder an → der nächste echte Wechsel (Spindel
an/aus) funktioniert sofort wieder, ganz ohne Neuladen der Seite.

## Test 4: Kurze, ungewollte Zustände lösen nichts aus ("Rauschschutz")

**Situation:** Zustände wie "Hold" (Pause) oder ein Alarm können manchmal ganz kurz auftreten — z.B. wenn
du aus Versehen kurz auf Pause drückst und sofort wieder fortsetzt.

**Problem:** Ohne Schutz würde JEDE noch so kurze, ungewollte Pause sofort deine Regel auslösen (z.B. die
Steckdose ausschalten), obwohl du gar keine echte, längere Pause wolltest.

**Lösung:** Genau wie beim Spindel-Beispiel oben gibt es auch hier eine kleine Wartezeit (delay) — die
Aktion feuert erst, wenn der Zustand tatsächlich eine Weile anhält, nicht bei jedem kurzen Zucken.

**So testest du es:** Lege eine Regel `hold → irgendeine Test-URL` an, `delay = 300`. Drücke Feed-Hold
(Pause) und **sofort** wieder Resume (Fortsetzen) → darf NICHT feuern (war schneller als die 300ms).
Halte Feed-Hold stattdessen länger als 300ms → jetzt feuert es.

Für Alarme genauso: löse einen Soft-Limit-Alarm aus und hebe ihn mit `$X` **sofort** wieder auf → darf
nicht feuern. Lass den Alarm wirklich eine Weile bestehen → feuert.

## Test 5: Wenn das Zielgerät langsam antwortet oder mehrfach angesprochen wird

**Situation:** Was, wenn die Steckdose (oder ein anderes Zielgerät) gerade langsam reagiert, und in der
Zwischenzeit dasselbe Ereignis nochmal auftritt, bevor die erste Anfrage überhaupt fertig ist?

**Problem:** Ohne Schutz könnten sich mehrere Anfragen überlappen, das Zielgerät mit einer Flut von
Anfragen überlasten, oder — schlimmer — eine wichtige zweite Anfrage könnte einfach verloren gehen, weil
die Oberfläche dachte, es sei schon alles erledigt.

**Lösung:** Zwei Schutzmechanismen zusammen: ein Mindestabstand zwischen zwei Anfragen (cooldown), plus
eine Sperre, die verhindert, dass zwei Anfragen gleichzeitig laufen. Passiert während der Sperre
trotzdem ein echter neuer Zustandswechsel, wird der NICHT verschluckt, sondern nachgeholt, sobald die
Sperre vorbei ist.

**So testest du es** (technischer Nachweis, kein Foto/Video nötig für den PR): du brauchst einen
absichtlich langsamen Test-Server — sag Bescheid, dann baue ich dir schnell einen kleinen (5 Zeilen
Python). Regel mit `cooldownms = 5000` gegen diesen langsamen Server, zweimal kurz hintereinander
auslösen → in der Konsole siehst du genau eine Meldung "previous request still in flight, skipped", keine
Anfragenflut, und nach Ablauf der Sperre feuert die nachgeholte Anfrage genau einmal.

## Test 6: Programmlauf starten/stoppen, auch bei Tür-Unterbrechung

**Situation:** Während ein Programm läuft und du zwischendurch die Schutztür öffnest (Not-Halt) und
wieder schließt und fortsetzt (Resume), soll das NICHT wie ein komplett neuer Start/Stop des Programms
behandelt werden — sonst würden z.B. Start-Aktionen (Licht an) unnötig mehrfach feuern.

**Problem:** Ohne genaue Unterscheidung könnte "Programm läuft wieder nach Tür-Resume" fälschlich wie ein
neuer "Programmstart" aussehen.

**Lösung:** Die Erkennung unterscheidet zwischen "Programm wirklich neu gestartet" und "Programm nach
Unterbrechung fortgesetzt" — nur ersteres löst `cycle_start` aus.

**So testest du es:** Lass ein kurzes Testprogramm laufen (z.B. `$H` gefolgt von `G0X10`, `G0X0`, oder
eine kleine Testdatei), mit angelegten Regeln für `cycle_start`/`cycle_stop`. Öffne während des Laufs die
Tür und schließe sie wieder, dann Resume → `cycle_stop` darf beim Türöffnen NICHT feuern, `cycle_start`
beim Fortsetzen NICHT erneut.

## Test 7: Tür auf/zu schaltet gleich zwei Geräte ("Türsicherung")

**Situation:** Öffnest du während des Betriebs die Schutztür (z.B. um kurz nachzusehen), sollen sowohl
die Fräse (Hauptstrom) als auch die Absaugung sofort abgeschaltet werden — schließt du die Tür wieder,
sollen beide wieder anlaufen.

**Problem:** Ohne diese Funktion müsstest du bei jedem Türöffnen beide Geräte selbst von Hand schalten,
und leicht vergisst man eines davon.

**Lösung:** Eine Regel kann mehrere Geräte gleichzeitig ansprechen — pro Ereignis legst du einfach
mehrere Zeilen an (ausführlicher dazu in Test 12). Die Vorlage "Türsicherung" macht das automatisch für
dich: `door_open` schaltet BEIDE Steckdosen aus, `door_closed` schaltet BEIDE wieder an.

**Wichtig:** das ist eine Komfort-Zusatzmaßnahme, KEIN Ersatz für eine echte, normgerechte
Sicherheitsverriegelung (Türschalter, der die Spindel zwangsweise stromlos macht) — falls deine Maschine
so etwas hat, bleibt das unabhängig davon weiter aktiv.

**So legst du die Regeln an:** Vorlagen-Button **"Türsicherung"** klicken — legt automatisch diese vier
Zeilen an:

| Ereignis | Ziel-URL | delay | cooldownms |
|---|---|---|---|
| Door opens | `http://192.168.30.3/cm?cmnd=Power%200` (Fräse aus) | 300 | 3000 |
| Door opens | `http://192.168.30.4/cm?cmnd=Power%20OFF` (Sauger aus) | 300 | 3000 |
| Door closes | `http://192.168.30.3/cm?cmnd=Power%201` (Fräse an) | 300 | 3000 |
| Door closes | `http://192.168.30.4/cm?cmnd=Power%20ON` (Sauger an) | 300 | 3000 |

**So testest du es:** Tür öffnen (oder den entsprechenden Sensor/Zustand simulieren) → beide Steckdosen
gehen im Network-Tab sichtbar aus. Tür wieder schließen → beide gehen wieder an.

## Test 8: Bei einem Alarm reagiert das System sofort

**Situation:** Ein Alarm (z.B. ein ausgelöster Endschalter) ist sicherheitsrelevant — da darf keine
spürbare Verzögerung entstehen, bis deine Regel (z.B. "Strom kappen") feuert.

**Problem:** Der normale Weg fragt den Maschinenzustand nur alle paar hundert Millisekunden ab — für
einen Alarm wäre das im Zweifel zu langsam.

**Lösung:** Für Alarme gibt es einen Extra-Schnellweg, der sofort reagiert, statt auf die nächste
reguläre Abfrage zu warten.

**So testest du es:** Löse einen echten Endschalter aus (oder einen Soft-Limit) → vergleiche im
Network-Tab die Zeitstempel und bestätige, dass die Anfrage quasi sofort kommt, nicht erst beim nächsten
periodischen Update.

## Test 9: Bei einem Alarm gehen Fräse UND Sauger aus ("Alarm-Absicherung")

**Situation:** Löst deine Steuerung einen Alarm aus (Endschalter, Not-Aus, Konfigurationsfehler), willst
du nicht nur die Absaugung, sondern auch den Hauptstrom der Fräse selbst sofort kappen.

**Problem:** Nur die Absaugung abzuschalten wäre bei einem echten Sicherheitsereignis zu wenig — der
Antrieb der Maschine bleibt sonst unter Strom.

**Lösung:** Die Vorlage "Alarm-Absicherung" bindet BEIDE Geräte an dasselbe Alarm-Ereignis.

**So legst du die Regeln an:** Vorlagen-Button **"Alarm-Absicherung"** klicken — legt automatisch an:

| Ereignis | Ziel-URL | delay | cooldownms |
|---|---|---|---|
| Alarm | `http://192.168.30.3/cm?cmnd=Power%200` (Fräse aus) | 300 | 3000 |
| Alarm | `http://192.168.30.4/cm?cmnd=Power%20OFF` (Sauger aus) | 300 | 3000 |

**So testest du es:** Löse einen Soft-Limit-Alarm aus (und lass ihn wirklich eine Weile bestehen, siehe
Test 4) → beide Steckdosen gehen im Network-Tab sichtbar aus.

## Test 10: Verbindung zum Board verloren/wiederhergestellt

**Wichtig zum Verständnis, bevor du das testest:** Die ganze Weboberfläche, die du im Browser siehst,
läuft als Programm **in deinem Browser-Tab** — der ESP32 liefert die Seite nur einmal aus wie ein kleiner
Webserver, führt sie aber selbst nicht aus. Wenn die Verbindung zum Board abbricht (`ws_disconnect`) oder
wiederkommt (`ws_connect`), ist es **dein Browser**, der das bemerkt und selbst — direkt aus deinem
PC/Handy heraus — die konfigurierte Anfrage an die Steckdose schickt. Der ESP32 tut hierbei nichts, er
könnte in diesem Moment sogar ausgeschaltet sein.

**Situation:** Du willst z.B., dass ein Licht/eine Warnleuchte angeht, sobald die Verbindung zur Maschine
abbricht (damit du es sofort merkst), und wieder ausgeht, sobald sie zurück ist.

**Problem 1:** Beim ersten Laden der Seite besteht ja auch "gerade eine Verbindung" — das darf nicht
fälschlich als "Verbindung wiederhergestellt" gewertet werden, sonst würde jede Seite, die du öffnest,
sofort feuern.

**Problem 2:** Während sich der Browser nach einem Verbindungsabbruch automatisch mehrfach neu zu
verbinden versucht, könnte jeder einzelne Versuch eine eigene Anfrage auslösen — das wäre eine
Anfragenflut statt einer sauberen "wieder da"-Meldung.

**Lösung:** Der allererste Verbindungsaufbau beim Laden der Seite zählt nicht als Ereignis (er ist der
"Startzustand", nicht ein "wiederhergestellt"). Und `ws_connect` hat eine längere empfohlene Wartezeit,
damit nicht jeder einzelne Wiederverbindungsversuch einzeln feuert, sondern erst der wirklich
erfolgreiche.

**So testest du es:** Regel anlegen, Seite neu laden → beim allerersten Verbindungsaufbau darf NICHTS
feuern. Trenne das Board kurz vom Strom oder WLAN → `ws_disconnect` feuert einmal. Board wieder online →
`ws_connect` feuert einmal (mit spürbarer, aber nicht störender Verzögerung).

## Test 11: Zieladresse falsch oder nicht erreichbar

**Situation:** Die eingetragene Adresse ist falsch, oder das Zielgerät ist gerade nicht im Netzwerk
erreichbar (z.B. Steckdose ausgesteckt).

**Problem:** Ohne Schutz könnte ein fehlgeschlagener Versuch eine störende Fehlermeldung zeigen oder gar
die Bedienung der restlichen Oberfläche blockieren.

**Lösung:** Ein Fehlschlag wird nur still im Hintergrund vermerkt (in der Entwicklerkonsole, `F12`) — die
Bedienung der restlichen Oberfläche bleibt uneingeschränkt möglich, nichts blockiert oder poppt auf.

**So testest du es:** Trage bei einer Regel eine nicht existierende Adresse ein, löse sie aus → in der
Konsole erscheint nur eine Zeile wie "Request failed: ...", keine Fehlermeldung auf dem Bildschirm, der
Rest der Seite bleibt normal bedienbar.

## Test 12: Mehrere Aktionen bei einem Ereignis, einzeln an/aus schaltbar

**Situation:** Bei EINEM Ereignis (z.B. Tür öffnen) willst du MEHRERE Dinge gleichzeitig auslösen, z.B.
sowohl die Fräse als auch die Absaugung ansprechen — genau das, was die "Türsicherung"-Vorlage aus Test 7
automatisch für dich tut.

**Problem:** Man könnte annehmen, dass pro Ereignis nur eine einzige Regel möglich ist.

**Lösung:** Das ist bereits eingebaut — lege einfach mehrere Regeln mit demselben Ereignis an, jede
feuert unabhängig von den anderen. Einzelne Regeln kannst du außerdem per Checkbox aus- und wieder
einschalten, ohne sie zu löschen.

**So testest du es:** Nimm die vier von "Türsicherung" angelegten Zeilen (oder lege selbst zwei Regeln
auf `door_open` an), deaktiviere eine davon über ihre Checkbox, löse das Ereignis aus → nur die aktiven
Regeln feuern.

## Test 13: Zwei Browser-Tabs gleichzeitig offen (nur zur Bestätigung, kein Fehler)

Passend zu Test 10: öffne dieselbe Seite in einem zweiten Tab oder Browser, konfiguriere eine Regel, löse
sie aus → **beide Tabs feuern unabhängig voneinander** (jeder Tab führt seine eigene Kopie der Logik
aus, wie in Test 10 erklärt). Das ist erwartetes, dokumentiertes Verhalten, keine Überraschung — hier
geht es nur darum, das einmal mit eigenen Augen zu bestätigen.

## Test 14: Bestehende Macros funktionieren weiterhin

Klicke ein paar deiner alten Macros durch (Typen `FS`/`SD`/`URI`/`URI_SILENT`/`CMD`), darunter eine
`URI_SILENT`-Macro gegen die echte Steckdose — muss sich exakt so verhalten wie vor diesem Update, ohne
Überraschungen.

## Test 15: Fräse geht automatisch mit dem Job an und aus ("Fräse-Sync")

**Situation:** Die Fräse soll von selbst angehen, sobald du ein Programm startest, und nach getaner
Arbeit auch wieder ausgehen — ohne dass du selbst an den Stecker denken musst.

**Problem beim Einschalten:** eigentlich kein Problem — sobald ein Programm bei der Steuerung ankommt und
zu laufen beginnt (`cycle_start`), kann sofort eingeschaltet werden. Das ist ein reiner
Software-Zustandswechsel der Steuerung, kein Henne-Ei-Problem: der ESP32-Controller ist ohnehin separat
von der Fräse-Steckdose versorgt, er kann ein Programm völlig unabhängig vom Zustand der Steckdose
annehmen.

**Problem beim Ausschalten:** würde die Fräse SOFORT nach Programmende abschalten, müsstest du sie jedes
Mal wieder manuell einschalten, auch wenn du eigentlich gleich den nächsten Job starten wolltest —
nervig bei mehreren Teilen hintereinander.

**Lösung:** Einschalten passiert sofort bei Programmstart (`cycle_start`). Ausschalten wartet dagegen 15
Sekunden nach Programmende (`cycle_stop`), bevor die Fräse wirklich abschaltet — genug Zeit, um gleich
den nächsten Job zu starten, ohne dass die Steckdose zwischendurch abschaltet.

**So legst du die Regeln an:** Vorlagen-Button **"Fräse-Sync"** klicken — legt automatisch beide Zeilen
an:

| Ereignis | Ziel-URL | delay | cooldownms |
|---|---|---|---|
| Cycle start | `http://192.168.30.3/cm?cmnd=Power%201` (Fräse an) | 300 | 3000 |
| Cycle stop | `http://192.168.30.3/cm?cmnd=Power%200` (Fräse aus) | 15000 | 3000 |

**Achtung, bewusster Kompromiss beim Ausschalten:** das schaltet die Fräse nach JEDEM abgeschlossenen Job
aus (nach 15s Wartezeit). Fährst du viele kleine Jobs kurz hintereinander mit größeren Pausen dazwischen,
wirst du die Fräse regelmäßig manuell wieder einschalten müssen — das ist Absicht, nicht ein Fehler, und
die Wartezeit lässt sich in der Regel jederzeit anpassen.

**Hinweis, falls dein Antrieb/VFD eine Hochlaufzeit nach dem Einschalten braucht:** das solltest du im
G-Code selbst berücksichtigen (z.B. die Spindel nicht gleich in der allerersten Zeile starten) — ist kein
Einschränkung dieser Vorlage, nur ein Hinweis.

**So testest du es:** wie in Test 1, kleine Bewegungsabfolge mit `M5` am Ende fahren, bis "Idle" erreicht
ist → die Fräse-Steckdose geht schon beim Start der Abfolge an, und 15 Sekunden nach dem Erreichen von
"Idle" wieder aus. Startest du innerhalb der 15 Sekunden ein neues Programm, bleibt sie an (gleicher
Rückgängig-Mechanismus wie bei "Staubsauger" in Test 1).

## Test 16: Ein Ereignis löst ein bereits gespeichertes Macro aus (statt einer stillen URL)

**Situation:** Du hast im Macros-Panel schon länger ein Macro angelegt — egal ob es eine URL aufruft,
G-Code an die Maschine schickt oder eine SD-Datei abspielt — und willst GENAU DAS jetzt automatisch bei
einem Ereignis auslösen lassen, statt die URL/den Befehl in der Event-Macro-Regel nochmal separat
einzutippen.

**Problem:** Ohne diese Funktion müsstest du dieselbe Aktion doppelt pflegen — einmal als normales Macro
zum manuellen Klicken, einmal als eigene "stille URL"-Regel für die Automatik. Änderst du später die
Adresse oder den Befehl, musst du daran denken, es an BEIDEN Stellen zu ändern.

**Lösung:** Eine Event-Macro-Regel kann jetzt statt einer eigenen URL auch direkt ein vorhandenes Macro
referenzieren. Beim Auslösen wird das Macro immer FRISCH aus deinen aktuellen Einstellungen geladen —
änderst du später die Macro-Definition, wirkt sich das automatisch auf die Regel aus, ohne dass du die
Regel selbst anfassen musst. Das funktioniert unabhängig davon, ob das Macros-Panel gerade auf dem
Bildschirm sichtbar ist oder nicht — du musst es also nicht offen lassen, damit die Automatik läuft.

**Wichtig, bewusste Entscheidung:** das funktioniert für JEDEN Macro-Typ, auch für Macros, die echten
G-Code an die Maschine schicken (Typ "CMD"). Das ist Absicht, keine Einschränkung — bedeutet aber auch:
überlege bei so einer Regel genauso sorgfältig wie bei jedem anderen automatisch ausgelösten
Maschinenbefehl, ob das Ereignis, an das du es bindest, dafür wirklich geeignet ist (z.B. Vorsicht bei
Bewegungsbefehlen, die an ein Ereignis gebunden sind, das durch genau diese Bewegung erneut ausgelöst
werden könnte).

**So legst du eine solche Regel an:**
1. Neue Regel anlegen (oder eine bestehende bearbeiten).
2. Beim Feld "Aktionstyp" (o.ä.) zwischen "Stille URL aufrufen" (Standard) und "Gespeichertes Macro
   aufrufen" wählen.
3. Bei "Gespeichertes Macro aufrufen" erscheint ein zweites Dropdown mit deinen vorhandenen Macros (nach
   Name) — das URL-Feld verschwindet, du wählst stattdessen ein Macro aus der Liste.
4. Speichern wie gewohnt.

**So testest du es:** Lege eine Regel an, die ein vorhandenes Macro referenziert (z.B. eines deiner
"Fräse an"/"Vac an"-Macros). **Blende das Macros-Panel aus** (falls gerade sichtbar), damit du
sicherstellst, dass es wirklich unabhängig vom Panel funktioniert. Löse das gebundene Ereignis aus (z.B.
über Terminal-Befehle wie in den vorherigen Tests) → das Macro feuert trotzdem, im Network-Tab bzw. in
der Konsole sichtbar, genau wie beim manuellen Klicken des Macro-Buttons. Lösche danach probeweise das
referenzierte Macro und löse das Ereignis nochmal aus → in der Konsole erscheint eine klare Meldung, dass
das Macro nicht mehr existiert — kein Absturz, keine Fehlermeldung auf dem Bildschirm.

## Für den PR mitnehmen

Aus der ganzen Liste reicht für den PR eine kleine, aussagekräftige Auswahl — ein Reviewer will in 2
Minuten verstehen, dass es funktioniert, nicht den ganzen Testplan nachvollziehen:

1. **Screenshot #1** — die neue Settings-Sektion (leer, Hauptschalter aus).
2. **Screenshot #2** — Trigger-Ereignis-Dropdown mit allen 10 Optionen.
3. **Kurzes Video** — Test 1 (Spindel an, Bewegungsabfolge, Steckdose geht erst nach der letzten Bewegung
   aus, nicht schon beim `M5`).
4. Optional ein zweites, kurzes Video — Test 7 oder Test 9 (Tür bzw. Alarm schaltet beide Steckdosen
   gleichzeitig, zeigt die Mehrfach-Regel-Fähigkeit an einem echten, sofort verständlichen Beispiel).
5. Optional **Screenshot #3** — der neue Hilfetext-Tooltip.

Alles andere aus der Liste ist wichtig zu TESTEN, aber nicht zu DOKUMENTIEREN — schreib bei Bedarf nur
eine Zeile in die PR-Beschreibung ("getestet: Rauschschutz, Cooldown/Nachhol-Verhalten,
Multi-Tab-Verhalten wie dokumentiert") statt für jeden Punkt ein Bild zu brauchen.

## Falls was schiefgeht

Ein Backup vom Gerätezustand direkt vor dem letzten Upload liegt hier:
```
C:\Users\walde\AppData\Local\Temp\claude\C--Users-walde-Desktop-repos-public-FluidNC\cc2f1367-b67e-4f25-9e05-4cabff0cb5f5\scratchpad\device\backup-pre-templates\
```
(`index.html.gz` + `preferences.json`, so wie sie unmittelbar davor auf dem Board lagen). Sag Bescheid,
dann lade ich das zurück.
