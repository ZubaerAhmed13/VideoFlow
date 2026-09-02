package com.videoflow.app.ui

import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.videoflow.app.MainActivity
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class HomeComposeTest {
    @get:Rule
    val rule = createAndroidComposeRule<MainActivity>()

    @Test
    fun homeNewProjectProjectDetailAndAddMediaAffordanceWork() {
        rule.onNodeWithText("VideoFlow").fetchSemanticsNode()
        rule.onNodeWithText("New Project").performClick()

        val projectNameField = rule.onNodeWithText("Project name")
        projectNameField.performTextClearance()
        projectNameField.performTextInput("Step 1 UI Test")

        rule.onNodeWithText("Create").performClick()
        rule.waitUntil(5_000) {
            runCatching {
                rule.onNodeWithText("Add Media").fetchSemanticsNode()
                true
            }.getOrDefault(false)
        }
        rule.onNodeWithText("Add Media").fetchSemanticsNode()
    }
}
