(function () {
  "use strict"

  var pages = Array.prototype.slice.call(document.querySelectorAll(".handbook-page"))
  var pageIds = pages.map(function (page) { return page.dataset.pageId })
  var searchInput = document.getElementById("handbook-search")
  var searchResults = document.getElementById("search-results")
  var markdownPayload = JSON.parse(document.getElementById("handbook-markdown").textContent)
  var markdownBySource = new Map(markdownPayload.pages.map(function (page) { return [page.source, page.markdown] }))
  var aliasesByHeading = new Map()
  markdownPayload.pages.forEach(function (page) {
    ;(page.aliases || []).forEach(function (alias) {
      aliasesByHeading.set(alias.id, ((aliasesByHeading.get(alias.id) || "") + " " + alias.text).trim())
    })
  })
  var selectedResult = -1
  var resultButtons = []

  function decodedHash() {
    var raw = window.location.hash.slice(1)
    try { return decodeURIComponent(raw) } catch (_) { return raw }
  }

  function pageForTarget(id) {
    var target = document.getElementById(id)
    var page = target && target.closest(".handbook-page")
    return page ? page.dataset.pageId : pageIds.indexOf(id) >= 0 ? id : pageIds[0]
  }

  function expandNavigation(pageId) {
    Array.prototype.forEach.call(document.querySelectorAll(".nav-chapter"), function (item) {
      var active = item.dataset.navPage === pageId
      item.classList.toggle("active", active)
      if (active) item.classList.add("expanded")
      var button = item.querySelector(".nav-toggle")
      if (button) button.setAttribute("aria-expanded", item.classList.contains("expanded") ? "true" : "false")
    })
  }

  function activatePage(pageId, targetId) {
    if (pageIds.indexOf(pageId) < 0) pageId = pageIds[0]
    pages.forEach(function (page) {
      var active = page.dataset.pageId === pageId
      page.classList.toggle("active", active)
      page.setAttribute("aria-hidden", active ? "false" : "true")
    })
    expandNavigation(pageId)
    var activePage = document.querySelector(".handbook-page.active")
    document.title = (activePage ? activePage.dataset.pageTitle + " — " : "") + "The Effect 4 Handbook"
    document.body.classList.remove("navigation-open")
    requestAnimationFrame(function () {
      var target = targetId && document.getElementById(targetId)
      if (target && target.closest(".handbook-page") === activePage) {
        if (target === activePage) window.scrollTo({ top: 0, behavior: "instant" })
        else target.scrollIntoView({ behavior: "instant", block: "start" })
        target.classList.remove("flash")
        void target.offsetWidth
        if (target !== activePage) target.classList.add("flash")
      } else {
        window.scrollTo({ top: 0, behavior: "instant" })
      }
      updateScrollState()
    })
  }

  function route() {
    var targetId = decodedHash()
    if (!targetId || !document.getElementById(targetId)) targetId = pageIds[0]
    activatePage(pageForTarget(targetId), targetId)
  }

  window.addEventListener("hashchange", route)
  document.addEventListener("click", function (event) {
    var anchor = event.target.closest("a[href^='#']")
    if (anchor && anchor.hash === window.location.hash) route()
    if (!event.target.closest(".search-box")) closeSearch()
  })

  Array.prototype.forEach.call(document.querySelectorAll(".nav-toggle"), function (button) {
    button.addEventListener("click", function () {
      var item = button.closest(".nav-chapter")
      item.classList.toggle("expanded")
      button.setAttribute("aria-expanded", item.classList.contains("expanded") ? "true" : "false")
    })
  })

  function sectionText(heading) {
    var parts = []
    var node = heading.nextElementSibling
    while (node && !/^H[1-4]$/.test(node.tagName)) {
      parts.push(node.textContent || "")
      node = node.nextElementSibling
    }
    return parts.join(" ").replace(/\s+/g, " ").trim()
  }

  var entries = Array.prototype.map.call(
    document.querySelectorAll("#handbook-source h1[id], #handbook-source h2[id], #handbook-source h3[id], #handbook-source h4[id]"),
    function (heading) {
      var page = heading.closest(".handbook-page")
      return {
        id: heading.id,
        level: Number(heading.tagName.slice(1)),
        title: heading.childNodes[0] ? heading.textContent.replace("\u200b", "").trim() : "",
        page: page ? page.dataset.pageTitle : "",
        text: [sectionText(heading), aliasesByHeading.get(heading.id) || ""].join(" ").replace(/\s+/g, " ").trim()
      }
    }
  )

  function search(query) {
    var terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
    if (!terms.length) { closeSearch(); return }
    var matches = entries.map(function (entry) {
      var title = entry.title.toLocaleLowerCase()
      var text = entry.text.toLocaleLowerCase()
      if (!terms.every(function (term) { return title.indexOf(term) >= 0 || text.indexOf(term) >= 0 })) return null
      var score = terms.reduce(function (total, term) {
        if (title === term) return total
        if (title.indexOf(term) === 0) return total + 1
        if (title.indexOf(term) >= 0) return total + 4
        return total + 10
      }, entry.level / 10)
      var at = text.indexOf(terms[0])
      var start = Math.max(0, at - 55)
      var snippet = entry.text.slice(start, start + 145)
      if (start > 0) snippet = "…" + snippet
      if (start + 145 < entry.text.length) snippet += "…"
      return { entry: entry, score: score, snippet: snippet }
    }).filter(Boolean).sort(function (left, right) {
      return left.score - right.score || left.entry.title.localeCompare(right.entry.title)
    }).slice(0, 16)

    searchResults.replaceChildren()
    selectedResult = -1
    resultButtons = []
    if (!matches.length) {
      var empty = document.createElement("div")
      empty.className = "search-empty"
      empty.textContent = "No matching sections"
      searchResults.appendChild(empty)
    } else {
      matches.forEach(function (match) {
        var button = document.createElement("button")
        button.type = "button"
        button.className = "search-result"
        button.setAttribute("role", "option")
        var title = document.createElement("strong")
        title.textContent = match.entry.title
        var context = document.createElement("span")
        context.textContent = match.entry.page + " · " + match.snippet
        button.append(title, context)
        button.addEventListener("click", function () {
          window.location.hash = match.entry.id
          closeSearch()
          searchInput.blur()
        })
        resultButtons.push(button)
        searchResults.appendChild(button)
      })
    }
    searchResults.classList.add("open")
  }

  function closeSearch() {
    searchResults.classList.remove("open")
    selectedResult = -1
  }

  function updateSelectedResult() {
    resultButtons.forEach(function (button, index) {
      button.classList.toggle("selected", index === selectedResult)
    })
    if (resultButtons[selectedResult]) resultButtons[selectedResult].scrollIntoView({ block: "nearest" })
  }

  searchInput.addEventListener("input", function () { search(searchInput.value) })
  searchInput.addEventListener("keydown", function (event) {
    if (event.key === "ArrowDown") {
      event.preventDefault()
      selectedResult = Math.min(selectedResult + 1, resultButtons.length - 1)
      updateSelectedResult()
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      selectedResult = Math.max(selectedResult - 1, 0)
      updateSelectedResult()
    } else if (event.key === "Enter" && resultButtons.length) {
      event.preventDefault()
      resultButtons[selectedResult < 0 ? 0 : selectedResult].click()
    } else if (event.key === "Escape") {
      searchInput.value = ""
      closeSearch()
      searchInput.blur()
    }
  })

  document.addEventListener("keydown", function (event) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") {
      event.preventDefault()
      searchInput.focus()
      searchInput.select()
    }
    if (event.key === "Escape") {
      document.body.classList.remove("navigation-open")
      closeSearch()
    }
  })

  document.getElementById("open-navigation").addEventListener("click", function () {
    document.body.classList.add("navigation-open")
  })
  document.getElementById("scrim").addEventListener("click", function () {
    document.body.classList.remove("navigation-open")
  })

  function setTheme(theme) {
    document.documentElement.dataset.theme = theme
    try { localStorage.setItem("effect-handbook-theme", theme) } catch (_) {}
  }
  var savedTheme
  try { savedTheme = localStorage.getItem("effect-handbook-theme") } catch (_) {}
  if (savedTheme === "light" || savedTheme === "dark") setTheme(savedTheme)
  Array.prototype.forEach.call(document.querySelectorAll(".theme-toggle"), function (button) {
    button.addEventListener("click", function () {
      setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light")
    })
  })

  async function copyText(text, button, resetLabel) {
    try {
      await navigator.clipboard.writeText(text)
    } catch (_) {
      var area = document.createElement("textarea")
      area.value = text
      area.style.position = "fixed"
      area.style.opacity = "0"
      document.body.appendChild(area)
      area.select()
      document.execCommand("copy")
      area.remove()
    }
    if (button) {
      button.textContent = "Copied"
      window.setTimeout(function () { button.textContent = resetLabel }, 1200)
    }
  }

  Array.prototype.forEach.call(document.querySelectorAll(".copy-code"), function (button) {
    button.addEventListener("click", function () {
      var block = button.closest('div[class^="language-"], div[class*=" language-"]')
      copyText(block.querySelector("code").textContent, button, "Copy")
    })
  })
  Array.prototype.forEach.call(document.querySelectorAll(".copy-markdown"), function (button) {
    button.addEventListener("click", function () {
      copyText(markdownBySource.get(button.dataset.pageSource) || "", button, "Copy page Markdown")
    })
  })

  function allMarkdown() {
    return markdownPayload.pages.map(function (page) { return page.markdown.trimEnd() }).join("\n\n") + "\n"
  }
  document.getElementById("copy-all-markdown").addEventListener("click", function (event) {
    copyText(allMarkdown(), event.currentTarget, "Copy all Markdown")
  })
  document.getElementById("download-all-markdown").addEventListener("click", function () {
    var url = URL.createObjectURL(new Blob([allMarkdown()], { type: "text/markdown;charset=utf-8" }))
    var anchor = document.createElement("a")
    anchor.href = url
    anchor.download = "effect-4-handbook-complete.md"
    anchor.click()
    window.setTimeout(function () { URL.revokeObjectURL(url) }, 0)
  })

  function updateScrollState() {
    var page = document.querySelector(".handbook-page.active")
    if (!page) return
    var moduleHeadings = Array.prototype.slice.call(page.querySelectorAll("h2[id]"))
    var current = null
    moduleHeadings.forEach(function (heading) {
      if (heading.getBoundingClientRect().top <= 140) current = heading.id
    })
    Array.prototype.forEach.call(document.querySelectorAll(".nav-module-link"), function (link) {
      link.classList.toggle("active", link.dataset.moduleLink === current)
    })
    var total = Math.max(1, document.documentElement.scrollHeight - window.innerHeight)
    var progress = Math.max(0, Math.min(1, window.scrollY / total))
    document.getElementById("reading-progress").style.width = (progress * 100) + "%"
  }
  window.addEventListener("scroll", updateScrollState, { passive: true })
  window.addEventListener("resize", updateScrollState)

  route()
})()
