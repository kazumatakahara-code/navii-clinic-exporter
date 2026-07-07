/**
 * config.js
 * ---------------------------------------------------------
 * ナビイ（医療情報ネット）のDOM構造に関する設定を一元管理する。
 * サイト構造が変わった場合は、まずこのファイルを見直すこと。
 * ここでは「セレクタ候補」「ラベル候補」「除外ルール」のみを定義し、
 * 実際の解析ロジックは content.js / utils.js 側に置く。
 * ---------------------------------------------------------
 */

/* global window */
(function (global) {
  "use strict";

  const NaviiConfig = {
    /** 対象ページ判定 */
    target: {
      hostname: "www.iryou.teikyouseido.mhlw.go.jp",
      pathIncludes: "/znk-web/juminkanja/S2400/"
    },

    /**
     * 検索結果一覧（S2400）で、1施設分の「カード/行」を探すための候補セレクタ。
     * 上から順に試し、最初にヒットしたものを採用する。
     * クラス名は変更されうるため、構造的な候補も含める。
     */
    listItemSelectors: [
      ".resultItems .item",
      "[class*='result'] [class*='item']",
      "[class*='search-result'] li",
      "[class*='list'] > li",
      "table.result-table tbody tr",
      "ul.searchResultList > li",
      "li[class*='facility']",
      "div[class*='facility']",
      "article"
    ],

    /** 一覧内で「医院名」らしきテキストを探す候補セレクタ（各カード内で相対検索） */
    nameSelectors: [
      "h3.name",
      "h2", "h3", "h4",
      "[class*='name']",
      "[class*='title']",
      "a[class*='name']",
      "th"
    ],

    /** 一覧内で「詳細」への遷移要素の候補 */
    detailLinkSelectors: [
      "h3.name a",
      "a[href*='S2430']",
      "a[href*='S2410']",
      "a[href*='detail']",
      "a[class*='detail']",
      "button[class*='detail']",
      "a[onclick]",
      "button[onclick]",
      "a"
    ],

    /** 「次へ」ボタン候補（ページネーション） */
    nextButtonSelectors: [
      "a[aria-label*='次']",
      "a[title*='次']",
      "button[aria-label*='次']",
      "button[title*='次']",
      "a[class*='next']",
      "button[class*='next']",
      "[class*='pagination'] a",
      "[class*='pager'] a"
    ],
    nextButtonTextPatterns: ["次へ", "次", "Next", ">"],

    /** 検索結果0件を示す文言候補 */
    zeroResultTextPatterns: [
      "該当する", "0件", "見つかりません", "検索結果はありません", "対象がありません"
    ],

    /** 総件数・総ページ数のテキストを探す際の周辺キーワード */
    totalCountLabelPatterns: ["件", "検索結果"],
    totalPageLabelPatterns: ["ページ", "/"],

    /** アクセス制限・エラーを検知するための文言候補 */
    blockedTextPatterns: [
      "403", "429", "503",
      "captcha", "CAPTCHA",
      "アクセス制限",
      "アクセスが集中しています",
      "しばらくしてから",
      "不正なアクセス"
    ],

    /**
     * 詳細ページの項目ラベル候補。
     * key: 内部で使う正規化済みフィールド名
     * labels: ページ上に現れうる表記ゆれの一覧
     */
    /**
     * 施設ではないノイズ（設備アイコンのバッジ、検索条件パネルなど）を
     * 誤って1施設として抽出しないための除外パターン。
     * 完全一致・部分一致の両方を候補として持つ。
     */
    nonFacilityExactPatterns: [
      "検索条件", "検索結果", "並び替え", "絞り込み",
      "喫煙対策あり", "禁煙", "分煙",
      "車椅子対応トイレあり", "車椅子利用者への配慮あり", "車いす対応",
      "視覚障がい者への配慮あり", "聴覚障がい者への配慮あり",
      "駐車場あり", "駐車場なし", "バリアフリー",
      "エレベーターあり", "オストメイト対応", "授乳室あり", "キッズスペースあり"
    ],
    /**
     * 上記に完全一致しなくても、「◯◯あり/なし」のような短い設備タグ的文言で、
     * 電話番号・郵便番号・詳細リンクなどの施設らしい情報を伴わない場合は
     * ノイズとみなすためのパターン。
     */
    nonFacilityTagSuffixPattern: /(あり|なし)$/,
    nonFacilityTagMaxLength: 20,

    detailFieldLabels: {
      name: ["正式名称", "医療機関名称", "医療機関名", "施設名称", "名称"],
      nameKana: ["正式名称カナ", "医療機関名称カナ", "医療機関名カナ", "名称カナ", "フリガナ"],
      postalCode: ["郵便番号"],
      address: ["所在地", "住所"],
      addressKana: ["住所カナ"],
      phone: ["電話番号", "電話", "TEL", "Tel", "tel"],
      fax: ["FAX", "Fax", "fax", "ファックス"],
      url: ["URL", "ホームページ", "ホームページアドレス", "Webサイト", "ウェブサイト"],
      departments: ["診療科目", "標榜科"],
      clinicHours: ["診療時間", "診療日", "外来診療時間"],
      receptionHours: ["受付時間", "外来受付時間"],
      closedDays: ["休診日"],
      director: ["管理者", "管理者氏名", "院長", "院長名", "代表者", "代表者名"],
      openedDate: ["開設年月日", "開業日"]
    },

    /**
     * 「名前」ラベルを検索する際、これらの文言を含む要素は除外する。
     * 例:「名称カナ」は「名称」を含むが、名前ラベルとしては採用しない。
     */
    nameExcludePatterns: ["カナ", "フリガナ"],

    /** 医療機関名の見出しらしき要素の候補（ラベルで見つからない場合のフォールバック） */
    nameHeadingSelectors: [
      "h1", "[class*='facilityName']", "[class*='pageTitle']", "[class*='clinicName']"
    ],

    /** 種別（機関区分）を探すためのラベル候補 */
    facilityTypeLabels: ["機関区分", "医療機関種別"],

    /** 種別（診療所／病院／歯科診療所）を判定するための文言候補（ラベル値に対してのみ使用する） */
    facilityTypePatterns: {
      "歯科診療所": ["歯科診療所", "歯科"],
      "病院": ["病院"],
      "診療所": ["診療所"]
    },

    /** 診療時間・診療科目などが別タブ・別画面にある場合に開くためのキーワード */
    scheduleTabKeywords: [
      "診療時間", "診療科目・診療時間", "診療内容", "診療日", "基本情報"
    ],

    /** 休診を表す文言（診療時間表のセル内で使用） */
    closedIndicatorPatterns: ["休診", "休", "-", "－", "―", "×", "なし"],

    /** 曜日の表記ゆれ→正規化後の1文字表記 */
    weekdayLabelAliases: {
      "月曜日": "月", "火曜日": "火", "水曜日": "水", "木曜日": "木",
      "金曜日": "金", "土曜日": "土", "日曜日": "日",
      "月曜": "月", "火曜": "火", "水曜": "水", "木曜": "木",
      "金曜": "金", "土曜": "土", "日曜": "日",
      "祝日": "祝", "祝祭日": "祝"
    },

    /** 公式HP判定：除外するドメイン・スキーム・拡張子 */
    urlExclusions: {
      domains: [
        "iryou.teikyouseido.mhlw.go.jp",
        "mhlw.go.jp"
      ],
      schemes: ["javascript:", "mailto:", "tel:"],
      extensions: [".pdf"],
      /** SNSのみのリンクを公式HPとして採用しないためのドメイン候補 */
      snsDomains: [
        "twitter.com", "x.com", "facebook.com", "instagram.com",
        "line.me", "youtube.com", "tiktok.com"
      ]
    },

    /** 曜日の固定順序 */
    weekdayOrder: ["月", "火", "水", "木", "金", "土", "日", "祝"],

    /** FAXであることを示すラベル文言（電話番号との切り分け用） */
    faxLabelPatterns: ["FAX", "Fax", "fax", "ファックス", "F A X"],

    /** 代表番号／昼間番号であることを示す文言（Tel1優先判定の補助） */
    primaryPhoneHintPatterns: ["代表", "昼", "本院", "受付"],

    /** 待機時間などの既定値 */
    defaults: {
      maxCount: null, // null = 制限なし
      listPageDelayMs: 1000,
      detailPageDelayMs: 1000,
      randomJitterMinMs: 200,
      randomJitterMaxMs: 500,
      retryCount: 2,
      detailConcurrency: 3,
      resumeFromCurrentPage: true,
      skipFetchedFacilities: true,
      fetchDetailPages: true
    },

    /** CSV列（固定・変更禁止） */
    csvColumns: [
      "UUID", "種別", "名前", "カナ", "郵便番号", "都道府県", "住所１", "住所２",
      "住所カナ", "Tel1", "Tel2", "Tel3", "Tel4", "FAX", "URL", "備考",
      "旧社名", "リードソース", "履歴", "記事名", "休診日", "診療日",
      "午前始", "午前終", "午後始", "午後終", "院長名", "開業日"
    ],

    errorCsvColumns: [
      "発生日時", "医院名", "詳細URL", "検索結果ページ", "処理段階", "エラー内容", "再試行回数"
    ],

    debugCsvColumns: [
      "詳細URL", "検索結果上の医院名", "取得した正式名称候補", "取得したカナ候補",
      "使用した名前ラベル", "使用したカナラベル", "検出した機関区分",
      "診療時間タブの有無", "診療時間タブを開けたか", "検出した曜日数", "検出した時間帯数",
      "検出した休診日", "検出した外部URL", "解析エラー"
    ],

    /** 都道府県一覧（住所抽出用） */
    prefectures: [
      "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
      "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
      "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県",
      "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県",
      "奈良県", "和歌山県", "鳥取県", "島根県", "岡山県", "広島県", "山口県",
      "徳島県", "香川県", "愛媛県", "高知県", "福岡県", "佐賀県", "長崎県",
      "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県"
    ]
  };

  global.NaviiConfig = NaviiConfig;
})(typeof window !== "undefined" ? window : globalThis);
