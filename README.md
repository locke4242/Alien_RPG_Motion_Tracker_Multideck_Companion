# Alien RPG - Motion Tracker Multideck Companion

This is a companion for **Alien RPG - Motion Tracker**. It lets the Motion Tracker detect moving tokens on other Foundry Scenes that represent different levels of the same ship, station, or facility.

The module keeps the original Motion Tracker intact. It does not create extra tokens, move tokens, or permanently change either Scene.

## Intended versions

- Foundry VTT v14, including build 365
- Alien RPG - Motion Tracker 1.5.5 or later

## Important update note

The displayed module name changed in version 1.0.1, but its internal Foundry module ID is still `motion-tracker-multideck`.

That is intentional. Keeping the same ID means you can replace version 1.0.0 with this version without losing the Scene links you already configured.

## What it does

Normally, the Motion Tracker checks only the Scene the user is currently viewing. This companion lets it also check other Scenes that you have linked to that Scene.

For example, if a ship has one Foundry Scene for its upper level and another Foundry Scene for its lower level, a character on either Scene can receive Motion Tracker contacts from both.

The tracker still behaves like the original Motion Tracker:

- Motionless and other ignored statuses still work.
- The original player-token filtering still works.
- The maximum tracker range still works.
- Contacts from another Scene look like ordinary contacts. Players are not told which Scene a contact is on.
- Several Scenes can be linked together, such as Scene A to Scene B and Scene B to Scene C.

## Installation

1. Stop Foundry.
2. Put the `motion-tracker-multideck` folder in your Foundry user-data `Data/modules/` folder.
3. Start Foundry.
4. Enable **Alien RPG - Motion Tracker** and **Alien RPG - Motion Tracker Multideck Companion** in the world.
5. Open **Configure Settings → Module Settings → Alien RPG - Motion Tracker Multideck Companion → Configure Scene Links**.


## Installing with a Manifest URL

For the normal installation, use this Manifest URL in Foundry:

`https://github.com/locke4242/Alien_RPG_Motion_Tracker_Multideck_Companion/releases/latest/download/module.json`

This address always points to the newest published release. Foundry can also use it later to check whether a newer version is available.

## Installing an older version

Older releases  stay available on GitHub. Each release includes its own `module.json` and `module.zip`.

To install a specific older version, use that release's version-specific Manifest URL. For version 1.0.1, use:

`https://github.com/locke4242/Alien_RPG_Motion_Tracker_Multideck_Companion/releases/download/1.0.1/module.json`

The same pattern works for later versions. For example, version 1.0.2 would use:

`https://github.com/locke4242/Alien_RPG_Motion_Tracker_Multideck_Companion/releases/download/1.0.2/module.json`

## Setting up two Scenes

1. Click **Add Scene Link**.
2. Choose **Scene A** and **Scene B**.
3. Enter **Scene B elevation compared with Scene A**. This is the real physical distance between the two levels, using the same distance unit as your Scene. For example, enter `3` if Scene B is 3 meters above Scene A.
4. Add a **Matching Point**. Click **Mark Scene A** and then click a recognizable location on Scene A. Next click **Mark Scene B** and click the same physical location on Scene B.
5. Save the Scene links.

A ladder, lift, stairwell, or teleporter landing is a good matching point because it represents the same physical place on both maps.

## How many matching points should I use?

Use the smallest number that makes the contacts line up correctly.

- **No matching points:** Use this only when both Scene maps already use exactly the same coordinates.
- **One matching point:** Usually enough when both maps face the same direction and use the same scale.
- **Two matching points:** Use this when one map is rotated or is a different size.
- **Three matching points:** Use this only when the maps are stretched differently and two points are not enough.

If contacts appear mirrored, rotated, or shifted to the wrong place, add another matching point or mark the existing points again.

## Contacts directly above or below

A normal Motion Tracker is a flat, two-dimensional display. A contact directly above or below the user has a distance, but no clear left/right direction on that display.

The setting **If a contact is exactly above or below** gives you two choices:

- **Show it at a consistent direction on the tracker:** The module chooses a repeatable direction for that contact. The blip stays in the same direction instead of jumping around, and the distance still includes the vertical separation.
- **Keep the blip in the center:** The contact remains in the middle of the tracker. In this special case, the original Motion Tracker's displayed distance cannot fully represent the vertical separation.

The first option is the default.

## Troubleshooting

If a contact on another Scene does not appear, first confirm that the original Motion Tracker can detect contacts on the user's current Scene. Then check that both Scenes are selected in an enabled Scene link and that the matching points correspond to the same physical locations.

If a contact appears in the wrong direction, mark the matching points again. Matching Point 1 on Scene A must represent the same physical location as Matching Point 1 on Scene B, and so on.

If you use several linked Scenes, make sure the elevation values are consistent. For example, if Scene B is 3 meters above Scene A and Scene C is 3 meters above Scene B, enter those relationships the same way in both Scene links.
