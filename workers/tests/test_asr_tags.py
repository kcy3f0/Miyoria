from tags import parse_sensevoice, to_language_code, to_language_name


def test_sherpa_fields():
    p = parse_sensevoice("早安", lang="<|zh|>", emotion="<|HAPPY|>", event="<|Laughter|>")
    assert (p.text, p.language, p.emotion, p.audio_events) == ("早安", "zh", "happy", ["laughter"])


def test_plain_speech_and_unknown_emotion_are_dropped():
    p = parse_sensevoice("hello", lang="<|en|>", emotion="<|EMO_UNKNOWN|>", event="<|Speech|>")
    assert p.emotion is None
    assert p.audio_events == []
    assert p.language == "en"


def test_inline_tags_are_parsed_and_stripped():
    p = parse_sensevoice("<|ja|><|ANGRY|><|BGM|><|withitn|>うるさい!")
    assert p.text == "うるさい!"
    assert (p.language, p.emotion, p.audio_events) == ("ja", "angry", ["bgm"])


def test_events_deduplicated_in_order():
    p = parse_sensevoice("<|Laughter|>x<|Applause|><|Laughter|>")
    assert p.audio_events == ["laughter", "applause"]


def test_missing_fields_are_fine():
    p = parse_sensevoice("  ")
    assert p.text == ""
    assert p.language is None
    assert p.emotion is None


def test_language_names():
    assert to_language_name("zh-TW") == "Chinese"
    assert to_language_name("ja") == "Japanese"
    assert to_language_name("Japanese") == "Japanese"
    assert to_language_name("auto") is None
    assert to_language_name(None) is None
    assert to_language_name("klingon") is None
    assert to_language_code("Chinese") == "zh"
    assert to_language_code("zh") == "zh"
    assert to_language_code("Cantonese") == "yue"
