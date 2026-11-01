// COMPILE-ONLY STUB -- NOT THE REAL BARITONE.
// Only used when libs/baritone-api-fabric-*.jar is missing, so that the unit tests can still compile and run.
// Never packaged into the mod. Signatures mirror Baritone 1.11.3 (Minecraft 1.21.1) for the members miyoria-bridge uses.
// Fix: ./gradlew downloadBaritone
package baritone.api.event.events;

public enum PathEvent {
    CALC_STARTED,
    CALC_FINISHED_NOW_EXECUTING,
    CALC_FAILED,
    NEXT_SEGMENT_CALC_STARTED,
    NEXT_SEGMENT_CALC_FINISHED,
    CONTINUING_ONTO_PLANNED_NEXT,
    SPLICING_ONTO_NEXT_EARLY,
    AT_GOAL,
    PATH_FINISHED_NEXT_STILL_CALCULATING,
    NEXT_CALC_FAILED,
    DISCARD_NEXT,
    CANCELED
}
