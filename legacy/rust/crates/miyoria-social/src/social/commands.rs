//! `/link`, `/me` and `/admin person ...`.

use std::sync::Arc;

use chrono::Utc;
use miyoria_commands::{
    ArgKind, ArgSpec, CommandRegistry, CommandReply, CommandSpec, Invocation, Permissions,
    parse_account,
};
use miyoria_types::{AccountRef, PersonId};

use super::engine::{LinkOutcome, Social};
use super::rel::{BLOCKED_TAG, EventKind, OWNER_TAG, is_blocked, label};
use super::rules::classify;

/// Paths registered by [`register_commands`].
pub const PATHS: &[&str] = &[
    "link",
    "me",
    "admin person show",
    "admin person tag",
    "admin person untag",
    "admin person block",
    "admin person unblock",
    "admin person reset",
    "admin person adjust",
];

const MAX_CALL_NAME_CHARS: usize = 20;
const MAX_TAG_CHARS: usize = 24;

/// Registers the social commands. Undo with [`unregister_commands`].
pub fn register_commands(registry: &CommandRegistry, social: Arc<Social>) -> anyhow::Result<()> {
    registry.set_group_description("admin person", "管理她認識的人");
    let perms = registry.permissions().clone();

    let s = social.clone();
    registry.register(
        CommandSpec::new("link", "把你的其他帳號連到同一個人(不帶代碼 = 取得代碼)")
            .arg(ArgSpec::new("code", "另一個帳號拿到的連結代碼", ArgKind::String).optional())
            .permission("me.link")
            .ephemeral(true),
        move |inv: Invocation| {
            let s = s.clone();
            async move { link(&s, &inv).await.map(CommandReply::ephemeral) }
        },
    )?;

    let s = social.clone();
    registry.register(
        CommandSpec::new("me", "看看她怎麼看你,或設定她怎麼叫你")
            .arg(ArgSpec::new("call", "想讓她怎麼叫你(「清除」= 取消)", ArgKind::String).optional())
            .permission("me.self")
            .ephemeral(true),
        move |inv: Invocation| {
            let s = s.clone();
            async move { me(&s, &inv).await.map(CommandReply::ephemeral) }
        },
    )?;

    let user = || {
        ArgSpec::new(
            "user",
            "要管理的人(@提及、platform:id 或名字)",
            ArgKind::User,
        )
    };
    let tag = || ArgSpec::new("tag", "標籤,例如 friend、regular、troll", ArgKind::String);
    let specs = [
        (
            AdminOp::Show,
            CommandSpec::new("admin person show", "看她對某人的詳細數值")
                .arg(user())
                .permission("admin.person.show"),
        ),
        (
            AdminOp::Tag,
            CommandSpec::new("admin person tag", "幫某人加標籤")
                .arg(user())
                .arg(tag())
                .permission("admin.person.tag"),
        ),
        (
            AdminOp::Untag,
            CommandSpec::new("admin person untag", "移除某人的標籤")
                .arg(user())
                .arg(tag())
                .permission("admin.person.tag"),
        ),
        (
            AdminOp::Block,
            CommandSpec::new("admin person block", "讓她不理某人")
                .arg(user())
                .permission("admin.person.block"),
        ),
        (
            AdminOp::Unblock,
            CommandSpec::new("admin person unblock", "解除封鎖")
                .arg(user())
                .permission("admin.person.block"),
        ),
        (
            AdminOp::Reset,
            CommandSpec::new("admin person reset", "把她對某人的印象歸零(標籤保留)")
                .arg(user())
                .permission("admin.person.reset"),
        ),
        (
            AdminOp::Adjust,
            CommandSpec::new("admin person adjust", "直接調整好感(只有主人能用)")
                .arg(user())
                .arg(ArgSpec::new(
                    "affinity",
                    "好感變化,-100 到 100",
                    ArgKind::Integer,
                ))
                .permission("admin.person.adjust"),
        ),
    ];
    for (op, spec) in specs {
        let s = social.clone();
        let perms = perms.clone();
        registry.register(spec.ephemeral(true), move |inv: Invocation| {
            let s = s.clone();
            let perms = perms.clone();
            async move {
                admin(&s, &perms, op, &inv)
                    .await
                    .map(CommandReply::ephemeral)
            }
        })?;
    }
    Ok(())
}

pub fn unregister_commands(registry: &CommandRegistry) {
    for path in PATHS {
        registry.unregister(path);
    }
}

async fn link(social: &Social, inv: &Invocation) -> anyhow::Result<String> {
    let now = Utc::now();
    let code = inv.str("code").map(str::trim).filter(|c| !c.is_empty());
    let Some(code) = code else {
        return Ok(
            match social
                .issue_link_code(&inv.invoker, &inv.invoker_display_name, now)
                .await?
            {
                Some(code) => format!(
                    "你的連結代碼是 `{code}`。十分鐘內用你的另一個帳號輸入 `/link code:{code}`……\
                     快點啦,我不會等你太久的。"
                ),
                None => "帳號連結現在沒辦法用……不是我的問題喔。".to_owned(),
            },
        );
    };
    let outcome = social
        .redeem_link_code(&inv.invoker, &inv.invoker_display_name, code, now)
        .await?;
    Ok(match outcome {
        LinkOutcome::Linked { .. } => {
            "好了,我知道這兩個帳號都是你了。哼,別以為換個帳號我就認不出來。".to_owned()
        }
        LinkOutcome::AlreadyLinked => "這兩個帳號本來就連在一起了啦。".to_owned(),
        LinkOutcome::SameAccount => "要用「另一個」帳號輸入代碼啦,笨蛋。".to_owned(),
        LinkOutcome::InvalidCode => "這個代碼不對,或是已經過期了。".to_owned(),
        LinkOutcome::TooManyAttempts => "你試太多次了,等一下再來。".to_owned(),
        LinkOutcome::Unavailable => "帳號連結現在沒辦法用……不是我的問題喔。".to_owned(),
    })
}

async fn me(social: &Social, inv: &Invocation) -> anyhow::Result<String> {
    let now = Utc::now();
    let Some(person) = social
        .resolve(&inv.invoker, Some(&inv.invoker_display_name), now)
        .await?
    else {
        return Ok("……你是誰?".to_owned());
    };
    let rel = social.relationship(person);
    let blocked = rel.as_ref().is_some_and(is_blocked);
    if let Some(call) = inv.str("call") {
        if blocked {
            return Ok("……我現在不想跟你說話。".to_owned());
        }
        let call = call.trim();
        if matches!(call, "清除" | "取消" | "reset" | "clear" | "-") {
            social.set_call_name(person, None, now).await?;
            return Ok("好啦,那我就照普通的方式叫你。".to_owned());
        }
        if let Err(why) = check_call_name(call) {
            return Ok(why.to_owned());
        }
        let label_now = rel.as_ref().map_or("陌生人", label);
        if label_now == "很討厭" {
            return Ok("我們有熟到可以這樣叫嗎?哼。".to_owned());
        }
        social
            .set_call_name(person, Some(call.to_owned()), now)
            .await?;
        return Ok(format!("……「{call}」是吧。知、知道了,我會這樣叫你的。"));
    }
    if blocked {
        return Ok("……我現在不想跟你說話。".to_owned());
    }
    let label_now = rel.as_ref().map_or("陌生人", label);
    let feeling = match label_now {
        "很討厭" => "……你自己心裡有數。",
        "討厭" => "老實說,我現在不太想理你。",
        "摯友" => "你、你是我最重要的朋友之一啦……這種話不要讓我說第二次!",
        "好朋友" => "哼,你算是我的好朋友……不准得意喔。",
        "朋友" => "勉、勉強算是朋友啦。",
        "認識" => "嗯……算是認識的人吧。",
        _ => "你誰啊?我們又不熟。",
    };
    let call = match rel.and_then(|r| r.call_name) {
        Some(c) => format!("我都叫你「{c}」。"),
        None => "你還沒告訴我要怎麼叫你,用 `/me call:名字` 設定吧。".to_owned(),
    };
    Ok(format!("在我心裡你是「{label_now}」。{feeling}\n{call}"))
}

/// Rejects names she would not use: too long, links / mentions, rude words.
fn check_call_name(call: &str) -> Result<(), &'static str> {
    let len = call.chars().count();
    if len == 0 {
        return Err("名字是空的啦。");
    }
    if len > MAX_CALL_NAME_CHARS {
        return Err("太長了,我才記不住!短一點。");
    }
    if call.contains(['\n', '@', '<', '>', '`']) || call.contains("://") {
        return Err("這種奇怪的東西我才不要叫。");
    }
    let rude = classify(call).iter().any(|k| {
        matches!(
            k,
            EventKind::Rude | EventKind::Insult | EventKind::Harassment | EventKind::FlirtTooFar
        )
    });
    if rude {
        return Err("才、才不要那樣叫你咧!換一個正常一點的啦。");
    }
    Ok(())
}

#[derive(Clone, Copy, Debug)]
enum AdminOp {
    Show,
    Tag,
    Untag,
    Block,
    Unblock,
    Reset,
    Adjust,
}

async fn admin(
    social: &Social,
    perms: &Permissions,
    op: AdminOp,
    inv: &Invocation,
) -> anyhow::Result<String> {
    let now = Utc::now();
    let user = inv.str("user").unwrap_or_default();
    let Some(person) = find_person(social, inv, user).await? else {
        return Ok(format!("我不認識「{}」這個人。", user.trim()));
    };
    let name = social
        .display_name(person)
        .unwrap_or_else(|| user.trim().to_owned());
    let by = format!("{}:{}", inv.invoker.platform, inv.invoker.id);
    let is_owner = || social.subject_is_owner(&inv.subject(), perms.is_owner(&inv.invoker));
    match op {
        AdminOp::Show => Ok(show(social, person, &name, now).await),
        AdminOp::Tag | AdminOp::Untag => {
            let on = matches!(op, AdminOp::Tag);
            let Some(tag) = normalize_tag(inv.str("tag").unwrap_or_default()) else {
                return Ok("標籤只能用小寫英數字、- 和 _,而且不能太長。".to_owned());
            };
            if tag == OWNER_TAG && !is_owner() {
                return Ok("`owner` 標籤只有我的主人能改!".to_owned());
            }
            let changed = social.set_tag(person, &tag, on, &by, now).await?;
            Ok(match (changed, on) {
                (true, true) => format!("幫 {name} 加上 `{tag}` 了。"),
                (true, false) => format!("{name} 的 `{tag}` 拿掉了。"),
                (false, true) => format!("{name} 本來就有 `{tag}` 了。"),
                (false, false) => format!("{name} 本來就沒有 `{tag}`。"),
            })
        }
        AdminOp::Block | AdminOp::Unblock => {
            let on = matches!(op, AdminOp::Block);
            let changed = social.set_tag(person, BLOCKED_TAG, on, &by, now).await?;
            Ok(match (changed, on) {
                (true, true) => format!("好,我不會再理 {name} 了。"),
                (true, false) => format!("好啦,我會再理 {name} 的……看他表現。"),
                (false, true) => format!("{name} 本來就被我封鎖了。"),
                (false, false) => format!("{name} 本來就沒被封鎖啊。"),
            })
        }
        AdminOp::Reset => {
            social.reset(person, &by, now).await?;
            Ok(format!("我對 {name} 的印象歸零了。……重新認識一次吧。"))
        }
        AdminOp::Adjust => {
            if !is_owner() {
                return Ok("這個只有我的主人能用,你、你又不是!".to_owned());
            }
            let delta = inv.int("affinity").unwrap_or(0);
            if !(-100..=100).contains(&delta) || delta == 0 {
                return Ok("好感變化要在 -100 到 100 之間,而且不能是 0。".to_owned());
            }
            let r = social.adjust(person, delta as f32, &by, now).await?;
            Ok(format!(
                "{name} 的好感調整了 {delta:+},現在是 {:.1}({})。……這是作弊吧。",
                r.affinity,
                label(&r)
            ))
        }
    }
}

async fn show(social: &Social, person: PersonId, name: &str, now: chrono::DateTime<Utc>) -> String {
    let Some(r) = social.relationship(person) else {
        return format!("我跟 {name} 還沒有任何交集。");
    };
    let mut out = format!(
        "**{name}**(person `{person}`)\n好感 {:.1} / 信任 {:.1} / 熟悉 {:.1} → {}",
        r.affinity,
        r.trust,
        r.familiarity,
        label(&r)
    );
    let tags = if r.tags.is_empty() {
        "無".to_owned()
    } else {
        r.tags.join("、")
    };
    out.push_str(&format!("\n標籤:{tags}"));
    out.push_str(&format!(
        "\n稱呼:{}",
        r.call_name.as_deref().unwrap_or("未設定")
    ));
    let last = r.last_interaction.map_or_else(
        || "從來沒有".to_owned(),
        |t| t.format("%Y-%m-%d %H:%M UTC").to_string(),
    );
    out.push_str(&format!("\n互動 {} 次,最後一次 {last}", r.interactions));
    if let Some(day) = social.today(person, now) {
        out.push_str(&format!(
            "\n今天:好感 +{:.1} / -{:.1}、信任 +{:.1} / -{:.1}",
            day.affinity_gained, day.affinity_lost, day.trust_gained, day.trust_lost
        ));
    }
    let notes = if r.notes.trim().is_empty() {
        "(還沒有)"
    } else {
        r.notes.trim()
    };
    out.push_str(&format!("\n印象:{notes}"));
    out
}

fn normalize_tag(tag: &str) -> Option<String> {
    let tag = tag.trim().to_lowercase();
    let ok = (1..=MAX_TAG_CHARS).contains(&tag.chars().count())
        && tag
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    ok.then_some(tag)
}

/// Resolves the `user` argument (mentions are already reduced to ids by the
/// registry): `platform:id`, a bare numeric id on the invoker's platform, or a
/// unique display name she knows.
async fn find_person(
    social: &Social,
    inv: &Invocation,
    user: &str,
) -> anyhow::Result<Option<PersonId>> {
    let s = user.trim();
    if s.is_empty() {
        return Ok(None);
    }
    let same_platform = |id: &str| AccountRef {
        platform: inv.context.platform.clone(),
        id: id.to_owned(),
    };
    let account = if s.chars().all(|c| c.is_ascii_digit()) {
        Some(same_platform(s))
    } else if s.contains(':') {
        parse_account(s).ok()
    } else {
        None
    };
    if let Some(account) = account {
        return social.resolve(&account, None, Utc::now()).await;
    }
    let named = social.people_named(s);
    Ok((named.len() == 1).then(|| named[0]))
}
