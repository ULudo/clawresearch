from clawresearch.cli.main import main


def test_console_entry_returns_success() -> None:
    assert main([]) == 0


def test_console_docs_returns_success() -> None:
    assert main(["--docs"]) == 0
