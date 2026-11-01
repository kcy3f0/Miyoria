// COMPILE-ONLY STUB -- NOT THE REAL BARITONE.
// Only used when libs/baritone-api-fabric-*.jar is missing, so that the unit tests can still compile and run.
// Never packaged into the mod. Signatures mirror Baritone 1.11.3 (Minecraft 1.21.1) for the members miyoria-bridge uses.
// Fix: ./gradlew downloadBaritone
package baritone.api;

import baritone.api.behavior.IPathingBehavior;
import baritone.api.command.manager.ICommandManager;
import baritone.api.event.listener.IEventBus;
import baritone.api.pathing.calc.IPathingControlManager;
import baritone.api.process.ICustomGoalProcess;
import baritone.api.process.IExploreProcess;
import baritone.api.process.IFarmProcess;
import baritone.api.process.IFollowProcess;
import baritone.api.process.IGetToBlockProcess;
import baritone.api.process.IMineProcess;

public interface IBaritone {
    IPathingBehavior getPathingBehavior();

    IFollowProcess getFollowProcess();

    IMineProcess getMineProcess();

    IExploreProcess getExploreProcess();

    IFarmProcess getFarmProcess();

    ICustomGoalProcess getCustomGoalProcess();

    IGetToBlockProcess getGetToBlockProcess();

    IPathingControlManager getPathingControlManager();

    IEventBus getGameEventHandler();

    ICommandManager getCommandManager();
}
