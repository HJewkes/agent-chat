import { LIVE, NAME } from './shell-words.js'

// zsh applies `:s/a/-b/`, `:t`, `:r` and the rest to an unbraced $NAME, even inside double quotes,
// so the word can become an option the guard never reads (CC-1290). A quoted colon stops it, but the
// marks cannot show that, so the guard fails closed. `f F w W x p` need a following modifier in zsh
// 5.9 and are kept anyway, for the same reason.
const UNBRACED_MODIFIER = new RegExp(
  `${LIVE}\\$[=~^#+]*(?:${NAME}|[0-9]+|[_#?!*@$-])(?:${LIVE}?\\[[^\\]]*\\])*${LIVE}?:${LIVE}?[aAcefFghlpPqQrstuwWxX&]`,
)

/** Whether zsh may apply a history-style modifier such as `:s/a/-b/` to an unbraced parameter in the marked word. */
export const appliesZshModifier = (marked: string): boolean => UNBRACED_MODIFIER.test(marked)
